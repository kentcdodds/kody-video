import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import {
  MAX_PROJECTS,
  newId,
  type AppMeta,
  type ClipId,
  type ClipMeta,
  type ClipRecord,
  type DeletedClipSnapshot,
  type Project,
  type ProjectId,
} from './types'

interface ClipsDB extends DBSchema {
  projects: {
    key: ProjectId
    value: Project
    indexes: { 'by-updated': number }
  }
  clips: {
    key: ClipId
    value: ClipRecord
    indexes: { 'by-project': ProjectId }
  }
  undo: {
    key: ProjectId
    value: DeletedClipSnapshot
  }
  meta: {
    key: string
    value: AppMeta
  }
}

export const DB_NAME = 'kody-video'
const DB_VERSION = 1

let dbPromise: Promise<IDBPDatabase<ClipsDB>> | null = null

export function getDb(): Promise<IDBPDatabase<ClipsDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ClipsDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const projects = db.createObjectStore('projects', { keyPath: 'id' })
        projects.createIndex('by-updated', 'updatedAt')

        const clips = db.createObjectStore('clips', { keyPath: 'id' })
        clips.createIndex('by-project', 'projectId')

        db.createObjectStore('undo', { keyPath: 'clip.projectId' })
        db.createObjectStore('meta', { keyPath: 'key' })
      },
    })
  }
  return dbPromise
}

/** Test helper: close open connections and clear the module-level DB handle. */
export async function __resetDbForTests(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise.catch(() => null)
    db?.close()
  }
  dbPromise = null
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('Failed to delete database'))
    req.onblocked = () => resolve()
  })
}

export async function getSettings(): Promise<AppMeta> {
  const db = await getDb()
  const existing = await db.get('meta', 'settings')
  const defaults: AppMeta = {
    key: 'settings',
    maxProjects: MAX_PROJECTS,
    lastOpenedProjectId: null,
    onboardingDismissed: false,
  }
  const settings = existing ? { ...defaults, ...existing } : defaults
  if (!existing || existing.onboardingDismissed === undefined) {
    await db.put('meta', settings)
  }
  return settings
}

export async function setLastOpenedProjectId(projectId: ProjectId | null): Promise<void> {
  const db = await getDb()
  const settings = await getSettings()
  await db.put('meta', { ...settings, lastOpenedProjectId: projectId })
}

export async function setOnboardingDismissed(onboardingDismissed: boolean): Promise<void> {
  const db = await getDb()
  const settings = await getSettings()
  await db.put('meta', { ...settings, onboardingDismissed })
}

export async function listProjects(): Promise<Project[]> {
  const db = await getDb()
  const projects = await db.getAllFromIndex('projects', 'by-updated')
  return projects.reverse()
}

export async function getProject(id: ProjectId): Promise<Project | undefined> {
  const db = await getDb()
  return db.get('projects', id)
}

export async function createProject(name?: string): Promise<Project> {
  const db = await getDb()
  const existing = await listProjects()
  const settings = await getSettings()
  if (existing.length >= settings.maxProjects) {
    throw new Error(`Project limit reached (${settings.maxProjects}). Delete a project to create another.`)
  }

  const now = Date.now()
  const project: Project = {
    id: newId('proj'),
    name: name?.trim() || defaultProjectName(existing.length + 1),
    createdAt: now,
    updatedAt: now,
    clipIds: [],
  }
  await db.put('projects', project)
  await setLastOpenedProjectId(project.id)
  return project
}

function defaultProjectName(n: number): string {
  return `Project ${n}`
}

export async function renameProject(id: ProjectId, name: string): Promise<Project> {
  const db = await getDb()
  const project = await db.get('projects', id)
  if (!project) throw new Error('Project not found')
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Name cannot be empty')
  const updated: Project = { ...project, name: trimmed, updatedAt: Date.now() }
  await db.put('projects', updated)
  return updated
}

export async function deleteProject(id: ProjectId): Promise<void> {
  const db = await getDb()
  const project = await db.get('projects', id)
  if (!project) return

  const tx = db.transaction(['projects', 'clips', 'undo', 'meta'], 'readwrite')
  for (const clipId of project.clipIds) {
    await tx.objectStore('clips').delete(clipId)
  }
  await tx.objectStore('undo').delete(id)
  await tx.objectStore('projects').delete(id)

  const settings = await tx.objectStore('meta').get('settings')
  if (settings?.lastOpenedProjectId === id) {
    await tx.objectStore('meta').put({ ...settings, lastOpenedProjectId: null })
  }
  await tx.done
}

export async function touchProject(id: ProjectId): Promise<void> {
  const db = await getDb()
  const project = await db.get('projects', id)
  if (!project) return
  await db.put('projects', { ...project, updatedAt: Date.now() })
}

export async function getClipsForProject(projectId: ProjectId): Promise<ClipRecord[]> {
  const db = await getDb()
  const project = await db.get('projects', projectId)
  if (!project) return []

  const clips: ClipRecord[] = []
  for (const clipId of project.clipIds) {
    const clip = await db.get('clips', clipId)
    if (clip) clips.push(clip)
  }
  return clips
}

export async function getClip(id: ClipId): Promise<ClipRecord | undefined> {
  const db = await getDb()
  return db.get('clips', id)
}

export async function getClipMetasForProject(projectId: ProjectId): Promise<ClipMeta[]> {
  const clips = await getClipsForProject(projectId)
  return clips.map(toMeta)
}

function toMeta(clip: ClipRecord): ClipMeta {
  const { blob: _blob, thumbs: _thumbs, ...meta } = clip
  return meta
}

export interface AddClipInput {
  projectId: ProjectId
  blob: Blob
  mimeType: string
  durationMs: number
  width?: number
  height?: number
}

export async function addClip(input: AddClipInput): Promise<ClipRecord> {
  const db = await getDb()
  const project = await db.get('projects', input.projectId)
  if (!project) throw new Error('Project not found')

  const now = Date.now()
  const clip: ClipRecord = {
    id: newId('clip'),
    projectId: input.projectId,
    blob: input.blob,
    mimeType: input.mimeType,
    durationMs: input.durationMs,
    trimStartMs: 0,
    trimEndMs: input.durationMs,
    createdAt: now,
    width: input.width,
    height: input.height,
  }

  const tx = db.transaction(['clips', 'projects'], 'readwrite')
  await tx.objectStore('clips').put(clip)
  await tx.objectStore('projects').put({
    ...project,
    clipIds: [...project.clipIds, clip.id],
    updatedAt: now,
  })
  await tx.done
  return clip
}

export interface ClipThumbsInput {
  thumbs: Blob[]
  thumbWidth: number
  thumbHeight: number
  videoWidth?: number
  videoHeight?: number
}

export async function updateClipThumbs(clipId: ClipId, input: ClipThumbsInput): Promise<void> {
  const db = await getDb()
  // Read + merge + write in one transaction so a concurrent trim/delete can
  // never be clobbered by a stale snapshot of the clip record.
  const tx = db.transaction('clips', 'readwrite')
  const clip = await tx.store.get(clipId)
  if (!clip) {
    await tx.done
    return
  }
  const updated: ClipRecord = {
    ...clip,
    thumbs: input.thumbs,
    thumbWidth: input.thumbWidth,
    thumbHeight: input.thumbHeight,
    width: clip.width ?? input.videoWidth,
    height: clip.height ?? input.videoHeight,
  }
  await tx.store.put(updated)
  await tx.done
}

export async function updateClipTrim(
  clipId: ClipId,
  trimStartMs: number,
  trimEndMs: number,
): Promise<ClipMeta> {
  const db = await getDb()
  const clip = await db.get('clips', clipId)
  if (!clip) throw new Error('Clip not found')

  const start = Math.max(0, Math.min(trimStartMs, clip.durationMs))
  const end = Math.max(start, Math.min(trimEndMs, clip.durationMs))
  const updated: ClipRecord = { ...clip, trimStartMs: start, trimEndMs: end }
  await db.put('clips', updated)
  await touchProject(clip.projectId)
  return toMeta(updated)
}

export async function reorderClips(projectId: ProjectId, clipIds: ClipId[]): Promise<Project> {
  const db = await getDb()
  const project = await db.get('projects', projectId)
  if (!project) throw new Error('Project not found')

  const set = new Set(project.clipIds)
  if (clipIds.length !== project.clipIds.length || clipIds.some((id) => !set.has(id))) {
    throw new Error('Invalid clip order')
  }

  const updated: Project = { ...project, clipIds, updatedAt: Date.now() }
  await db.put('projects', updated)
  return updated
}

export async function moveClip(
  projectId: ProjectId,
  clipId: ClipId,
  direction: 'left' | 'right',
): Promise<Project> {
  const project = await getProject(projectId)
  if (!project) throw new Error('Project not found')
  const index = project.clipIds.indexOf(clipId)
  if (index < 0) throw new Error('Clip not in project')

  const next = [...project.clipIds]
  const swapWith = direction === 'left' ? index - 1 : index + 1
  if (swapWith < 0 || swapWith >= next.length) return project
  ;[next[index], next[swapWith]] = [next[swapWith], next[index]]
  return reorderClips(projectId, next)
}

export async function duplicateClip(clipId: ClipId): Promise<ClipRecord> {
  const db = await getDb()
  const clip = await db.get('clips', clipId)
  if (!clip) throw new Error('Clip not found')
  const project = await db.get('projects', clip.projectId)
  if (!project) throw new Error('Project not found')

  const index = project.clipIds.indexOf(clipId)
  const now = Date.now()
  const copy: ClipRecord = {
    ...clip,
    id: newId('clip'),
    createdAt: now,
    blob: clip.blob.slice(0, clip.blob.size, clip.blob.type),
  }

  const clipIds = [...project.clipIds]
  clipIds.splice(index + 1, 0, copy.id)

  const tx = db.transaction(['clips', 'projects'], 'readwrite')
  await tx.objectStore('clips').put(copy)
  await tx.objectStore('projects').put({
    ...project,
    clipIds,
    updatedAt: now,
  })
  await tx.done
  return copy
}

export async function deleteClip(clipId: ClipId): Promise<DeletedClipSnapshot | null> {
  const db = await getDb()
  const clip = await db.get('clips', clipId)
  if (!clip) return null
  const project = await db.get('projects', clip.projectId)
  if (!project) return null

  const index = project.clipIds.indexOf(clipId)
  if (index < 0) return null

  const snapshot: DeletedClipSnapshot = {
    clip,
    index,
    deletedAt: Date.now(),
  }

  const clipIds = project.clipIds.filter((id) => id !== clipId)
  const tx = db.transaction(['clips', 'projects', 'undo'], 'readwrite')
  await tx.objectStore('clips').delete(clipId)
  await tx.objectStore('projects').put({
    ...project,
    clipIds,
    updatedAt: Date.now(),
  })
  await tx.objectStore('undo').put(snapshot)
  await tx.done
  return snapshot
}

export async function getUndoSnapshot(projectId: ProjectId): Promise<DeletedClipSnapshot | undefined> {
  const db = await getDb()
  return db.get('undo', projectId)
}

export async function undoDeleteLastClip(projectId: ProjectId): Promise<ClipRecord | null> {
  const db = await getDb()
  const snapshot = await db.get('undo', projectId)
  if (!snapshot) return null

  const project = await db.get('projects', projectId)
  if (!project) return null

  const clipIds = [...project.clipIds]
  const insertAt = Math.min(snapshot.index, clipIds.length)
  clipIds.splice(insertAt, 0, snapshot.clip.id)

  const tx = db.transaction(['clips', 'projects', 'undo'], 'readwrite')
  await tx.objectStore('clips').put(snapshot.clip)
  await tx.objectStore('projects').put({
    ...project,
    clipIds,
    updatedAt: Date.now(),
  })
  await tx.objectStore('undo').delete(projectId)
  await tx.done
  return snapshot.clip
}

export async function clearUndo(projectId: ProjectId): Promise<void> {
  const db = await getDb()
  await db.delete('undo', projectId)
}

export async function projectTotalDurationMs(projectId: ProjectId): Promise<number> {
  const clips = await getClipMetasForProject(projectId)
  return clips.reduce((sum, clip) => {
    const end = Math.min(clip.trimEndMs, clip.durationMs)
    const start = Math.max(0, Math.min(clip.trimStartMs, end))
    return sum + (end - start)
  }, 0)
}
