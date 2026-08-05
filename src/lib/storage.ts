import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { removeExportEntry } from './export/opfs'
import {
  DEFAULT_AUDIO_VOLUME,
  FREE_PROJECTS,
  MAX_PROJECTS,
  clampVolume,
  newId,
  type AppMeta,
  type ClipId,
  type ClipMeta,
  type ClipRecord,
  type DeletedClipSnapshot,
  type Project,
  type ProjectAudioRecord,
  type ProjectAudioTrack,
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
  audio: {
    key: ProjectId
    value: ProjectAudioRecord
  }
}

export const DB_NAME = 'kody-video'
const DB_VERSION = 2

let dbPromise: Promise<IDBPDatabase<ClipsDB>> | null = null

/**
 * Finish an explicit idb transaction without leaking AbortError.
 *
 * `tx.done` is created eagerly and rejects as soon as any request fails —
 * often before a later `await tx.done` runs. Awaiting the requests and
 * `tx.done` together keeps that rejection in the same catch path (see
 * jakearchibald/idb#320). Otherwise Sentry sees `AbortError: AbortError`
 * via `unhandledrejection` as a twin of the real store error.
 */
async function completeTransaction(
  ops: Array<Promise<unknown>>,
  tx: { done: Promise<void> },
): Promise<void> {
  await Promise.all([...ops, tx.done])
}

export function getDb(): Promise<IDBPDatabase<ClipsDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ClipsDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const projects = db.createObjectStore('projects', { keyPath: 'id' })
          projects.createIndex('by-updated', 'updatedAt')

          const clips = db.createObjectStore('clips', { keyPath: 'id' })
          clips.createIndex('by-project', 'projectId')

          db.createObjectStore('undo', { keyPath: 'clip.projectId' })
          db.createObjectStore('meta', { keyPath: 'key' })
        }
        if (oldVersion < 2) {
          // One optional background-audio track per project.
          db.createObjectStore('audio', { keyPath: 'projectId' })
        }
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

export async function setLocationTaggingEnabled(locationTaggingEnabled: boolean): Promise<void> {
  const db = await getDb()
  const settings = await getSettings()
  await db.put('meta', { ...settings, locationTaggingEnabled })
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

/**
 * Soft project-cap / free-plan gate. Surfaced in-app as guidance (toast,
 * upsell); expected product behavior, never a crash report.
 */
export class ProjectLimitError extends Error {
  override readonly name = 'ProjectLimitError'
}

export async function createProject(name?: string): Promise<Project> {
  const db = await getDb()
  const existing = await listProjects()
  const settings = await getSettings()
  if (existing.length >= settings.maxProjects) {
    throw new ProjectLimitError(
      `Project limit reached (${settings.maxProjects}). Delete a project to create another.`,
    )
  }
  // Free tier includes one project; the one-time Kody Video Plus purchase
  // (the watermark unlock) raises the cap to maxProjects. Enforced here so
  // every creation path (record, import) hits the same gate.
  if (settings.watermarkRemoved !== true && existing.length >= FREE_PROJECTS) {
    throw new ProjectLimitError(
      'The free plan includes 1 project — Kody Video Plus unlocks 6 (and removes the watermark).',
    )
  }

  const now = Date.now()
  const chosenName = name?.trim()
  const project: Project = {
    id: newId('proj'),
    name: chosenName || defaultProjectName(existing.length + 1),
    createdAt: now,
    updatedAt: now,
    clipIds: [],
  }
  // Marks eligibility for the default-state cleanup on exit — a
  // caller-chosen name is meaningful and must never be auto-deleted.
  if (!chosenName) project.nameIsDefault = true
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
  // Any rename is deliberate — even one back to a "Project N"-shaped name —
  // so the project stops being eligible for the default-state cleanup.
  delete updated.nameIsDefault
  await db.put('projects', updated)
  return updated
}

export async function deleteProject(id: ProjectId): Promise<void> {
  await deleteProjectRecords(id, { onlyIfPristine: false })
}

/**
 * Delete the project only when it is still indistinguishable from a freshly
 * created one: no clips, never renamed, no background music. Exiting such a
 * project should leave nothing behind — deleting it changes nothing the user
 * can see, so it happens silently. Any leftover undo snapshot (last clip
 * deleted, never restored) goes with it. Returns true when it was deleted.
 */
export async function deleteProjectIfPristine(id: ProjectId): Promise<boolean> {
  return deleteProjectRecords(id, { onlyIfPristine: true })
}

async function deleteProjectRecords(
  id: ProjectId,
  options: { onlyIfPristine: boolean },
): Promise<boolean> {
  const db = await getDb()
  const tx = db.transaction(['projects', 'clips', 'undo', 'meta', 'audio'], 'readwrite')
  const project = await tx.objectStore('projects').get(id)
  if (!project) {
    await tx.done
    return false
  }
  if (options.onlyIfPristine) {
    // Checked inside the deleting transaction: a clip save racing this
    // delete (exiting right as a take persists) serializes against it, so a
    // fresh clip can never survive into a half-deleted project.
    const audio = await tx.objectStore('audio').get(id)
    const pristine =
      project.clipIds.length === 0 &&
      project.nameIsDefault === true &&
      (!audio || audio.tracks.length === 0)
    if (!pristine) {
      await tx.done
      return false
    }
  }
  // Read meta before queueing writes so a failed delete cannot reject while
  // we are still awaiting get — that would reintroduce the AbortError leak.
  const settings = await tx.objectStore('meta').get('settings')
  const clips = tx.objectStore('clips')
  const ops: Array<Promise<unknown>> = [
    ...project.clipIds.map((clipId) => clips.delete(clipId)),
    tx.objectStore('undo').delete(id),
    tx.objectStore('audio').delete(id),
    tx.objectStore('projects').delete(id),
  ]
  const dropsCachedExport = settings?.lastExport?.projectId === id
  if (settings && (settings.lastOpenedProjectId === id || dropsCachedExport)) {
    ops.push(
      tx.objectStore('meta').put({
        ...settings,
        lastOpenedProjectId:
          settings.lastOpenedProjectId === id ? null : settings.lastOpenedProjectId,
        lastExport: dropsCachedExport ? undefined : settings.lastExport,
      }),
    )
  }
  await completeTransaction(ops, tx)

  // The cached export can be ~1GB — deleting a project must actually free
  // its space, not just its clips. Best-effort, after the commit.
  if (dropsCachedExport && settings?.lastExport) {
    await removeExportEntry(settings.lastExport.opfsName).catch(() => undefined)
  }
  return true
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
  lat?: number
  lng?: number
  locationAccuracyM?: number
  /** Original capture time — used when importing backups so chapter titles
   * keep the real recording time. Defaults to now. */
  createdAt?: number
  /** Background-music volume override — used when importing backups. */
  audioVolume?: number
}

/**
 * Copy blob bytes into a fresh Blob before IndexedDB persistence.
 * MediaRecorder / File-backed blobs can fail Chromium's object-store write
 * with UnknownError ("Error preparing Blob/File data to be stored…") when
 * the original backing store is ephemeral or already released.
 *
 * Prefer `mimeType` when the source Blob's type is empty so Safari does not
 * later reject an `application/octet-stream` object URL at export.
 */
export async function toStoredBlob(blob: Blob, mimeType?: string): Promise<Blob> {
  const buffer = await blob.arrayBuffer()
  return new Blob([buffer], { type: blob.type || mimeType || 'application/octet-stream' })
}

export async function addClip(input: AddClipInput): Promise<ClipRecord> {
  const db = await getDb()
  // Materialize before opening the transaction — awaiting inside a tx lets
  // IndexedDB auto-commit and abort subsequent puts. Re-read the project
  // inside the tx so overlapping saves cannot clobber fresher clipIds.
  const durableBlob = await toStoredBlob(input.blob, input.mimeType)

  const now = Date.now()
  const clip: ClipRecord = {
    id: newId('clip'),
    projectId: input.projectId,
    blob: durableBlob,
    mimeType: input.mimeType,
    durationMs: input.durationMs,
    trimStartMs: 0,
    trimEndMs: input.durationMs,
    createdAt: input.createdAt ?? now,
    width: input.width,
    height: input.height,
    lat: input.lat,
    lng: input.lng,
    locationAccuracyM: input.locationAccuracyM,
  }
  if (input.audioVolume !== undefined) {
    clip.audioVolume = clampVolume(input.audioVolume)
  }

  const tx = db.transaction(['clips', 'projects'], 'readwrite')
  const project = await tx.objectStore('projects').get(input.projectId)
  if (!project) {
    await tx.done.catch(() => undefined)
    throw new Error('Project not found')
  }
  await completeTransaction(
    [
      tx.objectStore('clips').put(clip),
      tx.objectStore('projects').put({
        ...project,
        clipIds: [...project.clipIds, clip.id],
        updatedAt: now,
      }),
    ],
    tx,
  )
  return clip
}

export interface ClipThumbsInput {
  thumbs: Blob[]
  poster: Blob
  thumbWidth: number
  thumbHeight: number
  videoWidth?: number
  videoHeight?: number
}

export async function updateClipThumbs(clipId: ClipId, input: ClipThumbsInput): Promise<void> {
  const db = await getDb()
  const [thumbs, poster] = await Promise.all([
    Promise.all(input.thumbs.map((thumb) => toStoredBlob(thumb))),
    toStoredBlob(input.poster),
  ])
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
    thumbs,
    poster,
    thumbWidth: input.thumbWidth,
    thumbHeight: input.thumbHeight,
    width: clip.width ?? input.videoWidth,
    height: clip.height ?? input.videoHeight,
  }
  await completeTransaction([tx.store.put(updated)], tx)
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

/** Set a clip's background-music volume override; null returns it to the
 * project audio track's default. */
export async function updateClipAudioVolume(
  clipId: ClipId,
  volume: number | null,
): Promise<ClipMeta> {
  const db = await getDb()
  // Read + merge + write in one transaction so a concurrent clip mutation
  // (trim, thumbs) can never be clobbered by a stale snapshot.
  const tx = db.transaction('clips', 'readwrite')
  const clip = await tx.store.get(clipId)
  if (!clip) {
    await tx.done.catch(() => undefined)
    throw new Error('Clip not found')
  }
  const updated: ClipRecord = { ...clip }
  if (volume === null) {
    delete updated.audioVolume
  } else {
    updated.audioVolume = clampVolume(volume)
  }
  await completeTransaction([tx.store.put(updated)], tx)
  await touchProject(clip.projectId)
  return toMeta(updated)
}

export async function getProjectAudio(
  projectId: ProjectId,
): Promise<ProjectAudioRecord | undefined> {
  const db = await getDb()
  return db.get('audio', projectId)
}

export interface AddProjectAudioTrackInput {
  projectId: ProjectId
  blob: Blob
  mimeType: string
  durationMs: number
  name: string
  /** Initial playlist settings — only honored when this is the first track. */
  defaultVolume?: number
  fadeIn?: boolean
  fadeOut?: boolean
}

/** Append a track to the project's background-music playlist (creating the
 * playlist with default settings when this is the first track). */
export async function addProjectAudioTrack(
  input: AddProjectAudioTrackInput,
): Promise<ProjectAudioRecord> {
  const db = await getDb()
  // Background music is a Kody Video Plus perk — enforced here so every
  // path that could attach a track (editor picker, backup import) hits the
  // same gate, like the project cap in createProject.
  const settings = await getSettings()
  if (settings.watermarkRemoved !== true) {
    throw new Error('Background music is part of Kody Video Plus — the one-time $0.99 unlock.')
  }
  const durableBlob = await toStoredBlob(input.blob, input.mimeType)
  const track: ProjectAudioTrack = {
    id: newId('track'),
    blob: durableBlob,
    mimeType: input.mimeType,
    durationMs: input.durationMs,
    name: input.name,
    addedAt: Date.now(),
  }
  // Read + merge + write in one transaction so overlapping playlist
  // mutations can never clobber each other's tracks or settings.
  const tx = db.transaction('audio', 'readwrite')
  const existing = await tx.store.get(input.projectId)
  const record: ProjectAudioRecord = existing
    ? { ...existing, tracks: [...existing.tracks, track] }
    : {
        projectId: input.projectId,
        tracks: [track],
        defaultVolume: clampVolume(input.defaultVolume ?? DEFAULT_AUDIO_VOLUME),
        fadeIn: input.fadeIn ?? true,
        fadeOut: input.fadeOut ?? true,
      }
  await completeTransaction([tx.store.put(record)], tx)
  await touchProject(input.projectId)
  return record
}

/** Remove one playlist track; removing the last one drops the playlist. */
export async function removeProjectAudioTrack(
  projectId: ProjectId,
  trackId: string,
): Promise<void> {
  const db = await getDb()
  const tx = db.transaction('audio', 'readwrite')
  const audio = await tx.store.get(projectId)
  if (!audio) {
    await tx.done
    return
  }
  const tracks = audio.tracks.filter((track) => track.id !== trackId)
  await completeTransaction(
    [
      tracks.length === 0
        ? tx.store.delete(projectId)
        : tx.store.put({ ...audio, tracks }),
    ],
    tx,
  )
  await touchProject(projectId)
}

export async function removeProjectAudio(projectId: ProjectId): Promise<void> {
  const db = await getDb()
  await db.delete('audio', projectId)
  await touchProject(projectId)
}

export interface ProjectAudioSettings {
  defaultVolume?: number
  fadeIn?: boolean
  fadeOut?: boolean
}

export async function updateProjectAudioSettings(
  projectId: ProjectId,
  settings: ProjectAudioSettings,
): Promise<ProjectAudioRecord> {
  const db = await getDb()
  const tx = db.transaction('audio', 'readwrite')
  const audio = await tx.store.get(projectId)
  if (!audio) {
    await tx.done.catch(() => undefined)
    throw new Error('This project has no background music')
  }
  const updated: ProjectAudioRecord = {
    ...audio,
    defaultVolume:
      settings.defaultVolume !== undefined
        ? clampVolume(settings.defaultVolume)
        : audio.defaultVolume,
    fadeIn: settings.fadeIn ?? audio.fadeIn,
    fadeOut: settings.fadeOut ?? audio.fadeOut,
  }
  await completeTransaction([tx.store.put(updated)], tx)
  await touchProject(projectId)
  return updated
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
  const source = await db.get('clips', clipId)
  if (!source) throw new Error('Clip not found')

  const now = Date.now()
  const [blob, thumbs, poster] = await Promise.all([
    toStoredBlob(source.blob, source.mimeType),
    source.thumbs
      ? Promise.all(source.thumbs.map((thumb) => toStoredBlob(thumb)))
      : Promise.resolve(undefined),
    source.poster ? toStoredBlob(source.poster) : Promise.resolve(undefined),
  ])

  const tx = db.transaction(['clips', 'projects'], 'readwrite')
  const clip = await tx.objectStore('clips').get(clipId)
  const project = clip
    ? await tx.objectStore('projects').get(clip.projectId)
    : undefined
  if (!clip || !project) {
    await tx.done.catch(() => undefined)
    throw new Error(!clip ? 'Clip not found' : 'Project not found')
  }

  const index = project.clipIds.indexOf(clipId)
  if (index < 0) {
    await tx.done.catch(() => undefined)
    throw new Error('Clip not in project')
  }

  const copy: ClipRecord = {
    ...clip,
    id: newId('clip'),
    createdAt: now,
    blob,
    thumbs,
    poster,
  }
  const clipIds = [...project.clipIds]
  clipIds.splice(index + 1, 0, copy.id)

  await completeTransaction(
    [
      tx.objectStore('clips').put(copy),
      tx.objectStore('projects').put({
        ...project,
        clipIds,
        updatedAt: now,
      }),
    ],
    tx,
  )
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
  await completeTransaction(
    [
      tx.objectStore('clips').delete(clipId),
      tx.objectStore('projects').put({
        ...project,
        clipIds,
        updatedAt: Date.now(),
      }),
      tx.objectStore('undo').put(snapshot),
    ],
    tx,
  )
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
  await completeTransaction(
    [
      tx.objectStore('clips').put(snapshot.clip),
      tx.objectStore('projects').put({
        ...project,
        clipIds,
        updatedAt: Date.now(),
      }),
      tx.objectStore('undo').delete(projectId),
    ],
    tx,
  )
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
