import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { removeExportEntry } from './export/opfs'
import {
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
/** Bumped when a migration must re-run for already-open clients. */
export const DB_VERSION = 3

let dbPromise: Promise<IDBPDatabase<ClipsDB>> | null = null
let activeDb: IDBPDatabase<ClipsDB> | null = null

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

/**
 * Ensure every object store exists. Version gates alone are not enough: a
 * version-less `indexedDB.open('kody-video')` (e.g. a diagnostic page) can
 * create an empty version-1 DB, after which `oldVersion < 1` skips the
 * original stores and only `audio` is added on the v2 bump.
 */
export function ensureObjectStores(db: {
  objectStoreNames: DOMStringList
  createObjectStore: IDBPDatabase<ClipsDB>['createObjectStore']
}): void {
  if (!db.objectStoreNames.contains('projects')) {
    const projects = db.createObjectStore('projects', { keyPath: 'id' })
    projects.createIndex('by-updated', 'updatedAt')
  }
  if (!db.objectStoreNames.contains('clips')) {
    const clips = db.createObjectStore('clips', { keyPath: 'id' })
    clips.createIndex('by-project', 'projectId')
  }
  if (!db.objectStoreNames.contains('undo')) {
    db.createObjectStore('undo', { keyPath: 'clip.projectId' })
  }
  if (!db.objectStoreNames.contains('meta')) {
    db.createObjectStore('meta', { keyPath: 'key' })
  }
  if (!db.objectStoreNames.contains('audio')) {
    // One optional background-audio playlist per project.
    db.createObjectStore('audio', { keyPath: 'projectId' })
  }
}

/** True when IndexedDB rejected because the cached connection is gone. */
export function isStaleConnectionError(error: unknown): boolean {
  if (!(error instanceof DOMException) && !(error instanceof Error)) return false
  if (error.name !== 'InvalidStateError') return false
  return /database connection is (closing|closed)/i.test(error.message)
}

function forgetCachedDb(closedDb?: IDBPDatabase<ClipsDB> | null): void {
  // A concurrent reopen may already own the cache — don't clobber it.
  if (closedDb && activeDb && closedDb !== activeDb) return
  activeDb = null
  dbPromise = null
}

function openTrackedDb(): Promise<IDBPDatabase<ClipsDB>> {
  // Capture this open's handle in terminated — activeDb may already point at
  // a newer reconnect by the time the close event runs.
  const tracked = openDB<ClipsDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      ensureObjectStores(db)
    },
    terminated() {
      // iOS Safari often closes IDB when the page is backgrounded. Drop the
      // singleton so the next getDb() opens a fresh connection.
      void tracked.then((db) => forgetCachedDb(db))
    },
  }).then((db) => {
    activeDb = db
    return db
  })
  return tracked
}

/**
 * Open (or reuse) the app IndexedDB connection.
 *
 * The handle is cached, but browsers — especially iOS Safari — may close it
 * out from under us. getDb() clears the cache on close and, if a caller still
 * holds a closing handle, probes and reopens once so getSettings/load-home
 * does not surface InvalidStateError.
 */
export async function getDb(): Promise<IDBPDatabase<ClipsDB>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!dbPromise) {
      dbPromise = openTrackedDb().catch((error) => {
        forgetCachedDb()
        throw error
      })
    }
    const pending = dbPromise
    try {
      const db = await pending
      // transaction() throws InvalidStateError while the connection is
      // closing/closed — before the close event clears our cache (KODY-VIDEO-F).
      db.transaction('meta')
      return db
    } catch (error) {
      if (!isStaleConnectionError(error) || attempt === 1) throw error
      if (dbPromise === pending) {
        const stale = activeDb
        forgetCachedDb(stale)
        try {
          stale?.close()
        } catch {
          // Already closing/closed.
        }
      }
    }
  }
  // Unreachable: the loop either returns or throws on the final attempt.
  throw new Error('Failed to open IndexedDB')
}

/** Test helper: close open connections and clear the module-level DB handle. */
export async function __resetDbForTests(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise.catch(() => null)
    db?.close()
  }
  forgetCachedDb()
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

export async function setKeepWatermark(keepWatermark: boolean): Promise<void> {
  const db = await getDb()
  const settings = await getSettings()
  await db.put('meta', { ...settings, keepWatermark })
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
  /** Default trim-out point; recordings pass the release point so the
   * stop-grace tail (real media past the finger-lift) starts trimmed off. */
  trimEndMs?: number
  width?: number
  height?: number
  lat?: number
  lng?: number
  locationAccuracyM?: number
  /** Original capture time — used when importing backups so chapter titles
   * keep the real recording time. Defaults to now. */
  createdAt?: number
  /** Per-clip volume overrides — used when importing backups. */
  clipVolume?: number
  musicVolume?: number
  /** Measured whole-clip audio peak — used when importing backups so the
   * clip skips the normalization re-measure on its first load. */
  audioPeak?: number
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
    trimEndMs: Math.max(0, Math.min(input.trimEndMs ?? input.durationMs, input.durationMs)),
    createdAt: input.createdAt ?? now,
    width: input.width,
    height: input.height,
    lat: input.lat,
    lng: input.lng,
    locationAccuracyM: input.locationAccuracyM,
  }
  if (input.clipVolume !== undefined && clampVolume(input.clipVolume) < 1) {
    clip.clipVolume = clampVolume(input.clipVolume)
  }
  if (input.musicVolume !== undefined && clampVolume(input.musicVolume) < 1) {
    clip.musicVolume = clampVolume(input.musicVolume)
  }
  if (input.audioPeak !== undefined && Number.isFinite(input.audioPeak)) {
    clip.audioPeak = Math.max(0, Math.min(1, input.audioPeak))
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

export interface ClipVolumeSettings {
  /** The clip's own (foreground) sound level; undefined = leave as is. */
  clipVolume?: number | null
  /** Music level while this clip plays; undefined = leave as is. */
  musicVolume?: number | null
}

/** Set a clip's volume levels. Full volume (1) is the default, so a value
 * of 1 or null clears the stored override. */
export async function updateClipVolumes(
  clipId: ClipId,
  volumes: ClipVolumeSettings,
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
  const apply = (field: 'clipVolume' | 'musicVolume', value: number | null | undefined) => {
    if (value === undefined) return
    const clamped = value === null ? 1 : clampVolume(value)
    if (clamped >= 1) {
      delete updated[field]
    } else {
      updated[field] = clamped
    }
  }
  apply('clipVolume', volumes.clipVolume)
  apply('musicVolume', volumes.musicVolume)
  await completeTransaction([tx.store.put(updated)], tx)
  await touchProject(clip.projectId)
  return toMeta(updated)
}

/** Persist a clip's measured audio peak (the normalization measurement).
 * Not a user edit — the project's updatedAt is deliberately untouched. */
export async function updateClipAudioPeak(clipId: ClipId, peak: number): Promise<void> {
  const db = await getDb()
  const tx = db.transaction('clips', 'readwrite')
  const clip = await tx.store.get(clipId)
  if (!clip) {
    await tx.done
    return
  }
  const audioPeak = Number.isFinite(peak) ? Math.max(0, Math.min(1, peak)) : 0
  await completeTransaction([tx.store.put({ ...clip, audioPeak })], tx)
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
  /** Initial playlist fade settings — only honored on the first track. */
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

export interface ProjectAudioTrackSettings {
  trimStartMs?: number
  trimEndMs?: number
  volume?: number
  fadeIn?: boolean
  fadeOut?: boolean
}

/** Update one playlist track's playback settings (trim window, level,
 * fades). Trim values clamp into the media like updateClipTrim. */
export async function updateProjectAudioTrack(
  projectId: ProjectId,
  trackId: string,
  settings: ProjectAudioTrackSettings,
): Promise<ProjectAudioRecord> {
  const db = await getDb()
  const tx = db.transaction('audio', 'readwrite')
  const audio = await tx.store.get(projectId)
  const track = audio?.tracks.find((t) => t.id === trackId)
  if (!audio || !track) {
    await tx.done.catch(() => undefined)
    throw new Error(!audio ? 'This project has no background music' : 'Music track not found')
  }
  const updatedTrack: ProjectAudioTrack = { ...track }
  // Non-finite trim requests fall back to the stored values — a NaN must
  // never persist (it would poison every consumer's playback math).
  const finiteOr = (value: number | undefined, fallback: number): number =>
    value !== undefined && Number.isFinite(value) ? value : fallback
  if (settings.trimStartMs !== undefined || settings.trimEndMs !== undefined) {
    const requestedStart = finiteOr(settings.trimStartMs, track.trimStartMs ?? 0)
    const requestedEnd = finiteOr(settings.trimEndMs, track.trimEndMs ?? track.durationMs)
    const start = Math.max(0, Math.min(requestedStart, track.durationMs))
    updatedTrack.trimStartMs = start
    updatedTrack.trimEndMs = Math.max(start, Math.min(requestedEnd, track.durationMs))
  }
  if (settings.volume !== undefined) {
    if (Number.isFinite(settings.volume)) {
      updatedTrack.volume = Math.max(0, Math.min(1, settings.volume))
    } else {
      // A non-finite request must never persist — back to the default.
      delete updatedTrack.volume
    }
  }
  if (settings.fadeIn !== undefined) updatedTrack.fadeIn = settings.fadeIn
  if (settings.fadeOut !== undefined) updatedTrack.fadeOut = settings.fadeOut
  const updated: ProjectAudioRecord = {
    ...audio,
    tracks: audio.tracks.map((t) => (t.id === trackId ? updatedTrack : t)),
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
