import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb'
import { removeExportEntry } from './export/opfs'
import {
  FREE_PROJECTS,
  MAX_PROJECTS,
  clampImageDurationMs,
  clampVolume,
  newId,
  type AppMeta,
  type ClipFit,
  type ClipId,
  type ClipKind,
  type ClipMeta,
  type ClipRecord,
  type DeletedClipSnapshot,
  type Project,
  type ProjectAudioRecord,
  type ProjectAudioTrack,
  type ProjectId,
  type ProjectOrientation,
  type StoredClipRecord,
} from './types'
import {
  resetActiveVideoQualityForTests,
  resolveVideoQuality,
  setActiveVideoQuality,
  type VideoQualityPreset,
} from './video-quality'

interface ClipsDB extends DBSchema {
  projects: {
    key: ProjectId
    value: Project
    indexes: { 'by-updated': number }
  }
  clips: {
    key: ClipId
    value: StoredClipRecord
    indexes: { 'by-project': ProjectId }
  }
  /** Each clip's media bytes, keyed by clip id (see StoredClipRecord). */
  media: {
    key: ClipId
    value: ClipMediaRecord
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

interface ClipMediaRecord {
  clipId: ClipId
  blob: Blob
}

export const DB_NAME = 'kody-video'
/** Bumped when a migration must re-run for already-open clients. */
export const DB_VERSION = 4

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
 *
 * QuotaExceededError (KODY-VIDEO-12) is remapped to StorageQuotaExceededError
 * so callers get actionable copy even when the browser leaves message empty.
 */
async function completeTransaction(
  ops: Array<Promise<unknown>>,
  tx: { done: Promise<void> },
): Promise<void> {
  try {
    await Promise.all([...ops, tx.done])
  } catch (error) {
    throwMappedStorageWriteError(error)
  }
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
  if (!db.objectStoreNames.contains('media')) {
    // No eager move of existing inline blobs: copying every clip inside the
    // upgrade transaction needs the whole library free again, which is
    // exactly what a nearly-full device lacks. putClipRecord moves each
    // legacy blob on that clip's next write instead.
    db.createObjectStore('media', { keyPath: 'clipId' })
  }
}

interface PutStore<V> {
  put(value: V): Promise<unknown>
}

/**
 * Queue a clip-record write. The record itself never carries media: a
 * legacy inline blob moves into `media` (one copy, once), and every later
 * metadata write only rewrites the small record.
 */
function putClipRecord(
  clips: PutStore<StoredClipRecord>,
  media: PutStore<ClipMediaRecord>,
  record: StoredClipRecord,
): Array<Promise<unknown>> {
  const { blob, ...meta } = record
  const ops: Array<Promise<unknown>> = [clips.put(meta)]
  if (blob) ops.push(media.put({ clipId: record.id, blob }))
  return ops
}

/** A stored clip joined with its media; undefined when the bytes are gone. */
function withMedia(
  stored: StoredClipRecord | undefined,
  media: ClipMediaRecord | undefined,
): ClipRecord | undefined {
  if (!stored) return undefined
  const blob = media?.blob ?? stored.blob
  return blob ? { ...stored, blob } : undefined
}

/** True when IndexedDB rejected because the cached connection is gone. */
export function isStaleConnectionError(error: unknown): boolean {
  if (!(error instanceof DOMException) && !(error instanceof Error)) return false
  if (error.name !== 'InvalidStateError') return false
  return /database connection is (closing|closed)/i.test(error.message)
}

/**
 * Chromium LevelDB open failure (KODY-VIDEO-Y): the profile's IndexedDB
 * backing store will not open — disk pressure, profile corruption, AV locks,
 * or enterprise storage policy. Not an app logic bug; keep in sync with the
 * beforeSend matcher in error-reporting.ts.
 */
const IDB_BACKING_STORE_OPEN =
  /Internal error opening backing store for indexedDB\.open/i

/** True when IndexedDB.open failed because Chromium could not open LevelDB. */
export function isIndexedDbBackingStoreOpenFailure(error: unknown): boolean {
  if (!(error instanceof DOMException) && !(error instanceof Error)) return false
  if (IDB_BACKING_STORE_OPEN.test(error.message)) return true
  // Some wrappers put the DOMException name in the message ("UnknownError: …").
  return (
    error.name === 'UnknownError' &&
    /opening backing store/i.test(error.message)
  )
}

/**
 * True when this JS realm has no IndexedDB binding (KODY-VIDEO-10). Bots,
 * exotic shells, and non-browser hosts throw ReferenceError inside idb's
 * openDB; typeof is safe even when the identifier is undeclared.
 */
export function isIndexedDbMissing(): boolean {
  return typeof indexedDB === 'undefined'
}

/** True when idb (or raw indexedDB) threw because the global is absent. */
export function isIndexedDbMissingError(error: unknown): boolean {
  return (
    error instanceof ReferenceError && /indexedDB is not defined/i.test(error.message)
  )
}

/**
 * Soft storage-unavailable gate after IndexedDB.open fails environmentally.
 * Surfaced in-app as guidance; expected platform noise, never a crash report.
 */
export class IndexedDbUnavailableError extends Error {
  override readonly name = 'IndexedDbUnavailableError'

  constructor(
    message = 'This browser can’t open on-device storage right now. Free some disk space, close other kody.video tabs, or restart the browser — then reload.',
  ) {
    super(message)
  }
}

/** Actionable copy when IndexedDB / Cache rejects a write for quota. */
export const STORAGE_QUOTA_MESSAGE =
  'Device storage is full. Delete a project or clear cached exports, then try again.'

/**
 * Soft storage-full gate (KODY-VIDEO-12). Browser QuotaExceededError often has
 * an empty message ("No error message" in Sentry); wrap so in-app surfaces
 * guide the user. Expected device constraint, never a crash report.
 */
export class StorageQuotaExceededError extends Error {
  override readonly name = 'StorageQuotaExceededError'

  constructor(message = STORAGE_QUOTA_MESSAGE) {
    super(message)
  }
}

/**
 * True when the browser rejected a write because the origin quota is full.
 * Match by `error.name` — Chromium often leaves `message` empty.
 */
export function isQuotaExceededError(error: unknown): boolean {
  if (error instanceof StorageQuotaExceededError) return true
  if (!(error instanceof DOMException) && !(error instanceof Error)) return false
  return error.name === 'QuotaExceededError'
}

/** Remap raw quota DOMExceptions; rethrow everything else unchanged. */
export function throwMappedStorageWriteError(error: unknown): never {
  if (error instanceof StorageQuotaExceededError) throw error
  if (isQuotaExceededError(error)) throw new StorageQuotaExceededError()
  throw error
}

/**
 * True when an IndexedDB failure looks environmental — the connection or the
 * backing store gave out mid-operation (iOS Safari closing IDB under memory
 * pressure, Chromium's "Error preparing Blob/File data to be stored") — so an
 * idempotent write is worth one retry on a fresh connection. Caller mistakes
 * and hard limits (QuotaExceededError, ConstraintError) are excluded: a retry
 * would only repeat them.
 */
export function isRetriableIdbFailure(error: unknown): boolean {
  if (isStaleConnectionError(error)) return true
  if (isIndexedDbBackingStoreOpenFailure(error)) return true
  if (isQuotaExceededError(error)) return false
  if (!(error instanceof DOMException)) return false
  return (
    error.name === 'AbortError' ||
    error.name === 'UnknownError' ||
    error.name === 'InvalidStateError' ||
    error.name === 'TransactionInactiveError'
  )
}

function forgetCachedDb(closedDb?: IDBPDatabase<ClipsDB> | null): void {
  // Only clear when the terminating handle is still the active one (or no
  // handle was supplied). If activeDb is null, a reconnect may already be
  // in flight — leave that pending promise alone.
  if (closedDb != null && activeDb !== closedDb) return
  activeDb = null
  dbPromise = null
}

function openTrackedDb(): Promise<IDBPDatabase<ClipsDB>> {
  // idb's openDB reads the free `indexedDB` binding; missing globals throw
  // ReferenceError (KODY-VIDEO-10). Fail closed with the soft unavailable
  // gate so load-home shows guidance instead of a crash report.
  if (isIndexedDbMissing()) {
    return Promise.reject(new IndexedDbUnavailableError())
  }
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

function discardStaleDb(stale: IDBPDatabase<ClipsDB> | null, pending: Promise<IDBPDatabase<ClipsDB>> | null): void {
  if (pending && dbPromise !== pending) return
  forgetCachedDb(stale)
  try {
    stale?.close()
  } catch {
    // Already closing/closed.
  }
}

/**
 * Open (or reuse) the app IndexedDB connection.
 *
 * The handle is cached, but browsers — especially iOS Safari — may close it
 * out from under us. getDb() clears the cache on close and, if a caller still
 * holds a closing handle, probes and reopens once so getSettings/load-home
 * does not surface InvalidStateError. Chromium LevelDB open failures
 * (KODY-VIDEO-Y) and a missing IndexedDB global (KODY-VIDEO-10) map to
 * IndexedDbUnavailableError after any one-shot retry that applies.
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
      if (isIndexedDbMissingError(error) || error instanceof IndexedDbUnavailableError) {
        throw error instanceof IndexedDbUnavailableError
          ? error
          : new IndexedDbUnavailableError()
      }
      const retriable =
        isStaleConnectionError(error) || isIndexedDbBackingStoreOpenFailure(error)
      if (!retriable || attempt === 1) {
        if (isIndexedDbBackingStoreOpenFailure(error)) {
          throw new IndexedDbUnavailableError()
        }
        throw error
      }
      discardStaleDb(activeDb, pending)
    }
  }
  // Unreachable: the loop either returns or throws on the final attempt.
  throw new Error('Failed to open IndexedDB')
}

/**
 * Run an IndexedDB op, reopening once if Safari closes the connection after
 * getDb()'s liveness probe (or mid-await inside an idempotent read/write).
 */
export async function withDb<T>(fn: (db: IDBPDatabase<ClipsDB>) => Promise<T>): Promise<T> {
  try {
    const db = await getDb()
    return await fn(db)
  } catch (error) {
    if (!isStaleConnectionError(error)) throw error
    discardStaleDb(activeDb, dbPromise)
    return await fn(await getDb())
  }
}

/** Test helper: close open connections and clear the module-level DB handle. */
export async function __resetDbForTests(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise.catch(() => null)
    db?.close()
  }
  forgetCachedDb()
  resetActiveVideoQualityForTests()
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('Failed to delete database'))
    req.onblocked = () => resolve()
  })
}

export async function getSettings(): Promise<AppMeta> {
  return withDb(async (db) => {
    const existing = await db.get('meta', 'settings')
    const defaults: AppMeta = {
      key: 'settings',
      maxProjects: MAX_PROJECTS,
      lastOpenedProjectId: null,
      onboardingDismissed: false,
    }
    const settings = existing ? { ...defaults, ...existing } : defaults
    setActiveVideoQuality(settings.videoQuality, settings.watermarkRemoved === true)
    if (!existing || existing.onboardingDismissed === undefined) {
      await db.put('meta', settings)
    }
    return settings
  })
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

export async function setTourCardDismissed(tourCardDismissed: boolean): Promise<void> {
  const db = await getDb()
  const settings = await getSettings()
  await db.put('meta', { ...settings, tourCardDismissed })
}

export async function setLocationTaggingEnabled(locationTaggingEnabled: boolean): Promise<void> {
  const db = await getDb()
  const settings = await getSettings()
  if (locationTaggingEnabled && settings.watermarkRemoved !== true) {
    throw new PlusRequiredError('Location tagging is a Kody Video Plus perk.')
  }
  await db.put('meta', { ...settings, locationTaggingEnabled })
}

/** Serialize read-modify-write updates to the singleton meta record so two
 * rapid pref toggles cannot persist an older snapshot over a newer one. */
let metaWriteTail: Promise<void> = Promise.resolve()

function enqueueMetaWrite<T>(write: () => Promise<T>): Promise<T> {
  const run = metaWriteTail.then(write, write)
  metaWriteTail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export async function setVideoQuality(videoQuality: VideoQualityPreset): Promise<VideoQualityPreset> {
  return enqueueMetaWrite(async () => {
    const db = await getDb()
    const settings = await getSettings()
    const plus = settings.watermarkRemoved === true
    if (videoQuality === 'high' && !plus) {
      throw new PlusRequiredError('High video quality is a Kody Video Plus perk.')
    }
    const next = resolveVideoQuality(videoQuality, plus)
    setActiveVideoQuality(next, plus)
    await db.put('meta', { ...settings, videoQuality: next })
    return next
  })
}

export async function setKeepWatermark(keepWatermark: boolean): Promise<void> {
  await enqueueMetaWrite(async () => {
    const db = await getDb()
    const settings = await getSettings()
    await db.put('meta', { ...settings, keepWatermark })
  })
}

export async function setIncludeLocationInExports(
  includeLocationInExports: boolean,
): Promise<void> {
  await enqueueMetaWrite(async () => {
    const db = await getDb()
    const settings = await getSettings()
    if (includeLocationInExports && settings.watermarkRemoved !== true) {
      throw new PlusRequiredError('Location export is a Kody Video Plus perk.')
    }
    await db.put('meta', { ...settings, includeLocationInExports })
  })
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

export async function createProject(
  name?: string,
  options?: { orientation?: ProjectOrientation },
): Promise<Project> {
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
  if (options?.orientation === 'landscape') assertLandscapeAllowed(settings)

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
  if (options?.orientation === 'landscape') project.orientation = 'landscape'
  try {
    await db.put('projects', project)
  } catch (error) {
    throwMappedStorageWriteError(error)
  }
  await setLastOpenedProjectId(project.id)
  return project
}

function defaultProjectName(n: number): string {
  return `Project ${n}`
}

export async function renameProject(id: ProjectId, name: string): Promise<Project> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Name cannot be empty')
  const db = await getDb()
  const tx = db.transaction('projects', 'readwrite')
  const project = await tx.store.get(id)
  if (!project) {
    await tx.done
    throw new Error('Project not found')
  }
  const updated: Project = { ...project, name: trimmed, updatedAt: Date.now() }
  // Any rename is deliberate — even one back to a "Project N"-shaped name —
  // so the project stops being eligible for the default-state cleanup.
  delete updated.nameIsDefault
  await completeTransaction([tx.store.put(updated)], tx)
  return updated
}

/**
 * A Kody Video Plus perk was used without the entitlement. Surfaced in-app
 * as the upsell; expected product behavior, never a crash report.
 */
export class PlusRequiredError extends Error {
  override readonly name = 'PlusRequiredError'
}

function assertLandscapeAllowed(settings: Pick<AppMeta, 'watermarkRemoved'>): void {
  if (settings.watermarkRemoved !== true) {
    throw new PlusRequiredError('Landscape projects are a Kody Video Plus perk.')
  }
}

/**
 * Set the project's orientation — the lock primitive behind the first-take
 * rule (appendRecording) and backup restore. Landscape requires the Plus
 * entitlement (enforced here so every path hits the same gate); portrait is
 * always allowed and clears the stored field, so a portrait project is
 * indistinguishable from one made before orientation existed.
 */
export async function setProjectOrientation(
  id: ProjectId,
  orientation: ProjectOrientation,
): Promise<Project> {
  // Entitlement first, then a single read-modify-write transaction: rapid
  // toggles issue overlapping calls, and IndexedDB serializes same-scope
  // readwrite transactions in creation order — so the user's last tap is
  // also the last commit. A read outside the transaction (or an await
  // between paths) would let an earlier landscape write land after a later
  // portrait one.
  if (orientation === 'landscape') assertLandscapeAllowed(await getSettings())
  const db = await getDb()
  const tx = db.transaction('projects', 'readwrite')
  const project = await tx.store.get(id)
  if (!project) {
    await tx.done
    throw new Error('Project not found')
  }
  const updated: Project = { ...project, updatedAt: Date.now() }
  if (orientation === 'landscape') updated.orientation = 'landscape'
  else delete updated.orientation
  await completeTransaction([tx.store.put(updated)], tx)
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
  const tx = db.transaction(['projects', 'clips', 'media', 'undo', 'meta', 'audio'], 'readwrite')
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
    // Orientation deliberately does NOT block this: it is derived from the
    // first take (not a standalone choice), so a project emptied of clips
    // is back to its default state even when a lock was once recorded.
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
  // Every clip filed under the project, not just the listed ones: a record
  // that fell out of clipIds would otherwise outlive its project unseen.
  const filedClipIds = await tx.objectStore('clips').index('by-project').getAllKeys(id)
  const undo = await tx.objectStore('undo').get(id)
  const clipIds = new Set([...project.clipIds, ...filedClipIds])
  if (undo) clipIds.add(undo.clip.id)
  const clips = tx.objectStore('clips')
  const media = tx.objectStore('media')
  const ops: Array<Promise<unknown>> = [
    ...[...clipIds].flatMap((clipId) => [clips.delete(clipId), media.delete(clipId)]),
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

/** Bump updatedAt. Read and write share one transaction: a clip saved in
 * between must never be dropped from clipIds by a stale project snapshot
 * (its record would linger, unreachable, holding its media). */
export async function touchProject(id: ProjectId): Promise<void> {
  const db = await getDb()
  const tx = db.transaction('projects', 'readwrite')
  const project = await tx.store.get(id)
  if (!project) {
    await tx.done
    return
  }
  await completeTransaction([tx.store.put({ ...project, updatedAt: Date.now() })], tx)
}

export async function getClipsForProject(projectId: ProjectId): Promise<ClipRecord[]> {
  const db = await getDb()
  const tx = db.transaction(['projects', 'clips', 'media'])
  const project = await tx.objectStore('projects').get(projectId)
  if (!project) {
    await tx.done
    return []
  }
  const clipsStore = tx.objectStore('clips')
  const mediaStore = tx.objectStore('media')
  const clips = await Promise.all(
    project.clipIds.map(async (clipId) =>
      withMedia(await clipsStore.get(clipId), await mediaStore.get(clipId)),
    ),
  )
  await tx.done
  return clips.filter((clip): clip is ClipRecord => clip !== undefined)
}

export async function getClip(id: ClipId): Promise<ClipRecord | undefined> {
  const db = await getDb()
  const tx = db.transaction(['clips', 'media'])
  const [stored, media] = await Promise.all([
    tx.objectStore('clips').get(id),
    tx.objectStore('media').get(id),
  ])
  await tx.done
  return withMedia(stored, media)
}

export async function getClipMetasForProject(projectId: ProjectId): Promise<ClipMeta[]> {
  const clips = await getClipsForProject(projectId)
  return clips.map(toMeta)
}

function toMeta(clip: StoredClipRecord): ClipMeta {
  const { blob: _blob, thumbs: _thumbs, poster: _poster, ...meta } = clip
  return meta
}

export interface AddClipInput {
  projectId: ProjectId
  blob: Blob
  mimeType: string
  /** 'image' for a still photo shown for `durationMs`; omit for video. */
  kind?: ClipKind
  durationMs: number
  /** Default trim-in; adopted warm recordings skip encoder pre-roll. */
  trimStartMs?: number
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
  /** Insert after this clip (device Add). Omit to append at the end. */
  afterClipId?: ClipId
}

/** Place `clipId` immediately after `afterClipId`, or append when that id is missing. */
export function insertClipIdAfter(
  clipIds: ClipId[],
  clipId: ClipId,
  afterClipId?: ClipId | null,
): ClipId[] {
  const next = [...clipIds]
  if (afterClipId) {
    const index = next.indexOf(afterClipId)
    if (index >= 0) {
      next.splice(index + 1, 0, clipId)
      return next
    }
  }
  next.push(clipId)
  return next
}

/**
 * Copy blob bytes into a fresh Blob before IndexedDB persistence.
 * MediaRecorder / File-backed blobs can fail Chromium's object-store write
 * with UnknownError ("Error preparing Blob/File data to be stored…") when
 * the original backing store is ephemeral or already released.
 *
 * Large clips are copied in chunks: a single `arrayBuffer()` of a ~1GB
 * File (or File.slice) throws QuotaExceededError on many phones even when
 * disk quota is fine — the browser is refusing a giant RAM allocation, not
 * reporting a full disk. Chunked reads keep peak allocation small.
 *
 * Prefer `mimeType` when the source Blob's type is empty so Safari does not
 * later reject an `application/octet-stream` object URL at export.
 */
export const STORED_BLOB_CHUNK_BYTES = 8 * 1024 * 1024

export async function copyBlobForStorage(
  blob: Blob,
  mimeType?: string,
  chunkBytes: number = STORED_BLOB_CHUNK_BYTES,
): Promise<Blob> {
  const type = blob.type || mimeType || 'application/octet-stream'
  const size = chunkBytes > 0 ? chunkBytes : STORED_BLOB_CHUNK_BYTES
  if (blob.size <= size) {
    const buffer = await blob.arrayBuffer()
    return new Blob([buffer], { type })
  }
  // Read one chunk at a time and wrap it immediately. Holding every
  // ArrayBuffer until the end would keep peak RAM at the full file size
  // (the allocation that phones refuse). File.slice parts would not copy,
  // so IndexedDB can still fail on ephemeral picker / MediaRecorder blobs.
  const parts: Blob[] = []
  for (let offset = 0; offset < blob.size; offset += size) {
    const end = Math.min(offset + size, blob.size)
    const buffer = await blob.slice(offset, end).arrayBuffer()
    parts.push(new Blob([buffer]))
  }
  return new Blob(parts, { type })
}

export async function toStoredBlob(blob: Blob, mimeType?: string): Promise<Blob> {
  return copyBlobForStorage(blob, mimeType)
}

export async function addClip(input: AddClipInput): Promise<ClipRecord> {
  const db = await getDb()
  const isImage = input.kind === 'image'
  // Photos: clamp duration and pin the trim window at the storage gate so
  // a direct caller cannot bypass the import/backup clamps with an
  // out-of-range duration or a partial trim window.
  const durationMs = isImage
    ? clampImageDurationMs(input.durationMs)
    : input.durationMs
  // Materialize before opening the transaction — awaiting inside a tx lets
  // IndexedDB auto-commit and abort subsequent puts. Re-read the project
  // inside the tx so overlapping saves cannot clobber fresher clipIds.
  const durableBlob = await toStoredBlob(input.blob, input.mimeType)

  const now = Date.now()
  const trimEndMs = isImage
    ? durationMs
    : Math.max(0, Math.min(input.trimEndMs ?? durationMs, durationMs))
  const trimStartMs = isImage
    ? 0
    : Math.max(0, Math.min(input.trimStartMs ?? 0, trimEndMs))
  const clip: ClipRecord = {
    id: newId('clip'),
    projectId: input.projectId,
    blob: durableBlob,
    mimeType: input.mimeType,
    durationMs,
    trimStartMs,
    trimEndMs,
    createdAt: input.createdAt ?? now,
    ...(isImage ? { kind: 'image' as const } : {}),
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

  const tx = db.transaction(['clips', 'media', 'projects'], 'readwrite')
  const project = await tx.objectStore('projects').get(input.projectId)
  if (!project) {
    await tx.done.catch(() => undefined)
    throw new Error('Project not found')
  }
  await completeTransaction(
    [
      ...putClipRecord(tx.objectStore('clips'), tx.objectStore('media'), clip),
      tx.objectStore('projects').put({
        ...project,
        clipIds: insertClipIdAfter(project.clipIds, clip.id, input.afterClipId),
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
  const tx = db.transaction(['clips', 'media'], 'readwrite')
  const clip = await tx.objectStore('clips').get(clipId)
  if (!clip) {
    await tx.done
    return
  }
  const updated: StoredClipRecord = {
    ...clip,
    thumbs,
    poster,
    thumbWidth: input.thumbWidth,
    thumbHeight: input.thumbHeight,
    width: clip.width ?? input.videoWidth,
    height: clip.height ?? input.videoHeight,
  }
  await completeTransaction(
    putClipRecord(tx.objectStore('clips'), tx.objectStore('media'), updated),
    tx,
  )
}

export interface ReplaceClipMediaInput {
  blob: Blob
  mimeType: string
  durationMs: number
  trimStartMs?: number
  trimEndMs?: number
  width?: number
  height?: number
}

/**
 * Replace a clip's stored media (permanent trim / split). Thumbs, poster,
 * and audio-peak are cleared so the next hydrate rebuilds them for the
 * new bytes. Trim defaults to the full new duration.
 */
export async function replaceClipMedia(
  clipId: ClipId,
  input: ReplaceClipMediaInput,
): Promise<ClipRecord> {
  const durableBlob = await toStoredBlob(input.blob, input.mimeType)
  const durationMs = Math.max(0, Math.round(input.durationMs))
  const start = Math.max(0, Math.min(input.trimStartMs ?? 0, durationMs))
  const end = Math.max(start, Math.min(input.trimEndMs ?? durationMs, durationMs))

  const db = await getDb()
  const tx = db.transaction(['clips', 'media', 'projects'], 'readwrite')
  const clip = await tx.objectStore('clips').get(clipId)
  if (!clip) {
    await tx.done.catch(() => undefined)
    throw new Error('Clip not found')
  }
  const project = await tx.objectStore('projects').get(clip.projectId)
  if (!project) {
    await tx.done.catch(() => undefined)
    throw new Error('Project not found')
  }

  const updated: ClipRecord = {
    id: clip.id,
    projectId: clip.projectId,
    mimeType: input.mimeType,
    durationMs,
    trimStartMs: start,
    trimEndMs: end,
    createdAt: clip.createdAt,
    blob: durableBlob,
    ...(clip.kind ? { kind: clip.kind } : {}),
    width: input.width ?? clip.width,
    height: input.height ?? clip.height,
    ...(clip.lat !== undefined ? { lat: clip.lat } : {}),
    ...(clip.lng !== undefined ? { lng: clip.lng } : {}),
    ...(clip.locationAccuracyM !== undefined ? { locationAccuracyM: clip.locationAccuracyM } : {}),
    ...(clip.clipVolume !== undefined ? { clipVolume: clip.clipVolume } : {}),
    ...(clip.musicVolume !== undefined ? { musicVolume: clip.musicVolume } : {}),
  }

  await completeTransaction(
    [
      // Replaces the clip's media record: the old bytes go with it.
      ...putClipRecord(tx.objectStore('clips'), tx.objectStore('media'), updated),
      tx.objectStore('projects').put({
        ...project,
        updatedAt: Date.now(),
      }),
    ],
    tx,
  )
  return updated
}

/**
 * Read-merge-write one clip record in a single transaction. `edit` returns
 * the new record, or null to leave the stored one untouched.
 */
async function editClipRecord(
  clipId: ClipId,
  edit: (clip: StoredClipRecord) => StoredClipRecord | null,
): Promise<StoredClipRecord | undefined> {
  const db = await getDb()
  const tx = db.transaction(['clips', 'media'], 'readwrite')
  const clip = await tx.objectStore('clips').get(clipId)
  if (!clip) {
    await tx.done.catch(() => undefined)
    return undefined
  }
  let updated: StoredClipRecord | null
  try {
    updated = edit(clip)
  } catch (error) {
    await tx.done.catch(() => undefined)
    throw error
  }
  if (!updated) {
    await tx.done
    return clip
  }
  await completeTransaction(
    putClipRecord(tx.objectStore('clips'), tx.objectStore('media'), updated),
    tx,
  )
  return updated
}

export async function updateClipTrim(
  clipId: ClipId,
  trimStartMs: number,
  trimEndMs: number,
): Promise<ClipMeta> {
  const updated = await editClipRecord(clipId, (clip) => {
    const start = Math.max(0, Math.min(trimStartMs, clip.durationMs))
    const end = Math.max(start, Math.min(trimEndMs, clip.durationMs))
    return { ...clip, trimStartMs: start, trimEndMs: end }
  })
  if (!updated) throw new Error('Clip not found')
  await touchProject(updated.projectId)
  return toMeta(updated)
}

/** Crop is the default, so it clears the stored override. */
export async function updateClipFit(clipId: ClipId, fit: ClipFit): Promise<ClipMeta> {
  const updated = await editClipRecord(clipId, (clip) => {
    const next: StoredClipRecord = { ...clip }
    if (fit === 'letterbox') next.fit = 'letterbox'
    else delete next.fit
    return next
  })
  if (!updated) throw new Error('Clip not found')
  await touchProject(updated.projectId)
  return toMeta(updated)
}

/**
 * Set a photo clip's on-screen duration. Unlike a video trim, a photo has
 * no media length to clamp against — the duration IS the clip's length, so
 * it can grow as well as shrink. The trim window follows (0..duration): a
 * photo always shows in full, and every consumer of trims keeps working.
 */
export async function updateClipDuration(
  clipId: ClipId,
  durationMs: number,
): Promise<ClipMeta> {
  const clamped = clampImageDurationMs(durationMs)
  const updated = await editClipRecord(clipId, (clip) => {
    if (clip.kind !== 'image') {
      throw new Error('Only photos can change duration — trim videos instead')
    }
    return { ...clip, durationMs: clamped, trimStartMs: 0, trimEndMs: clamped }
  })
  if (!updated) throw new Error('Clip not found')
  await touchProject(updated.projectId)
  return toMeta(updated)
}

export interface ClipVolumeSettings {
  /** The clip's own (foreground) sound level; undefined = leave as is. */
  clipVolume?: number | null
  /** Music level while this clip plays; undefined = leave as is. */
  musicVolume?: number | null
}

/** In-flight volume writes per clip. Writes must apply in call order: a
 * slow retry (fresh connection + blob re-copy) from an earlier commit must
 * never land after — and silently undo — a newer slider commit. */
const clipVolumeWrites = new Map<ClipId, Promise<unknown>>()

/** Set a clip's volume levels. Full volume (1) is the default, so a value
 * of 1 or null clears the stored override. */
export async function updateClipVolumes(
  clipId: ClipId,
  volumes: ClipVolumeSettings,
): Promise<ClipMeta> {
  const previous = clipVolumeWrites.get(clipId) ?? Promise.resolve()
  const run = previous.then(
    () => writeClipVolumesWithRetry(clipId, volumes),
    () => writeClipVolumesWithRetry(clipId, volumes),
  )
  const tail = run.catch(() => undefined)
  clipVolumeWrites.set(clipId, tail)
  void tail.then(() => {
    if (clipVolumeWrites.get(clipId) === tail) clipVolumeWrites.delete(clipId)
  })
  return run
}

async function writeClipVolumesWithRetry(
  clipId: ClipId,
  volumes: ClipVolumeSettings,
): Promise<ClipMeta> {
  try {
    return await writeClipVolumes(clipId, volumes)
  } catch (error) {
    if (!isRetriableIdbFailure(error)) throw error
    // A volume write re-puts the clip record's thumbnail blobs (and, for a
    // record from before the media split, its inline video), so slider
    // commits are exposed to environmental IDB failures. Retry once on a
    // fresh connection with re-copied blobs: that covers both iOS Safari
    // closing the connection under us and the engine refusing to re-store
    // a Blob it itself returned. The write is idempotent, so a retry after
    // an ambiguous failure is safe.
    discardStaleDb(activeDb, dbPromise)
    return await writeClipVolumes(clipId, volumes, { rematerializeBlobs: true })
  }
}

/** Same stored bytes, as far as a cheap check can tell — presence, size,
 * and type. Blob identities never survive separate IDB reads, so this is
 * the signal for "did someone else replace this media meanwhile". */
function sameStoredBlob(a: Blob | undefined, b: Blob | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.size === b.size && a.type === b.type
}

function sameStoredBlobList(a: Blob[] | undefined, b: Blob[] | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.length === b.length && a.every((blob, i) => sameStoredBlob(blob, b[i]))
}

async function writeClipVolumes(
  clipId: ClipId,
  volumes: ClipVolumeSettings,
  options?: { rematerializeBlobs?: boolean },
): Promise<ClipMeta> {
  const db = await getDb()

  // Copy blob bytes into fresh Blobs before opening the transaction —
  // awaiting arrayBuffer() inside a tx would let it auto-commit, and the
  // whole point is to stop a possibly-poisoned stored Blob from failing
  // the put again.
  let fresh: {
    snapshot: StoredClipRecord
    blob?: Blob
    thumbs?: Blob[]
    poster?: Blob
  } | null = null
  if (options?.rematerializeBlobs) {
    const snapshot = await db.get('clips', clipId)
    if (!snapshot) throw new Error('Clip not found')
    fresh = {
      snapshot,
      blob: snapshot.blob ? await toStoredBlob(snapshot.blob, snapshot.mimeType) : undefined,
      thumbs: snapshot.thumbs
        ? await Promise.all(snapshot.thumbs.map((thumb) => toStoredBlob(thumb)))
        : undefined,
      poster: snapshot.poster ? await toStoredBlob(snapshot.poster) : undefined,
    }
  }

  // Read + merge + write in one transaction so a concurrent clip mutation
  // (trim, thumbs) can never be clobbered by a stale snapshot.
  const tx = db.transaction(['clips', 'media'], 'readwrite')
  const clip = await tx.objectStore('clips').get(clipId)
  if (!clip) {
    await tx.done.catch(() => undefined)
    throw new Error('Clip not found')
  }
  const updated: StoredClipRecord = { ...clip }
  if (fresh) {
    // Overlay a re-copied field only while the stored one still matches the
    // snapshot it was copied from — a concurrent thumbs/poster/trim write
    // that committed between the copy and this put must win over the copy.
    if (fresh.blob && sameStoredBlob(clip.blob, fresh.snapshot.blob)) updated.blob = fresh.blob
    if (fresh.thumbs && sameStoredBlobList(clip.thumbs, fresh.snapshot.thumbs)) {
      updated.thumbs = fresh.thumbs
    }
    if (fresh.poster && sameStoredBlob(clip.poster, fresh.snapshot.poster)) {
      updated.poster = fresh.poster
    }
  }
  let changed = false
  const apply = (field: 'clipVolume' | 'musicVolume', value: number | null | undefined) => {
    if (value === undefined) return
    const clamped = value === null ? 1 : clampVolume(value)
    if (clamped >= 1) {
      if (field in updated) changed = true
      delete updated[field]
    } else {
      if (updated[field] !== clamped) changed = true
      updated[field] = clamped
    }
  }
  apply('clipVolume', volumes.clipVolume)
  apply('musicVolume', volumes.musicVolume)
  // Re-committing the value already stored (a slider released twice on the
  // same spot) must not rewrite the record for nothing.
  if (!changed && !options?.rematerializeBlobs) {
    await tx.done
    return toMeta(updated)
  }
  await completeTransaction(
    putClipRecord(tx.objectStore('clips'), tx.objectStore('media'), updated),
    tx,
  )
  await touchProject(clip.projectId)
  return toMeta(updated)
}

/** Persist the file's display size (rotation-aware). Not a user edit —
 * the project's updatedAt is deliberately untouched. */
export async function updateClipSize(
  clipId: ClipId,
  width: number,
  height: number,
): Promise<void> {
  if (!(width > 0) || !(height > 0)) return
  await editClipRecord(clipId, (clip) =>
    clip.width === width && clip.height === height ? null : { ...clip, width, height },
  )
}

/** Persist a clip's measured audio peak (the normalization measurement).
 * Not a user edit — the project's updatedAt is deliberately untouched. */
export async function updateClipAudioPeak(clipId: ClipId, peak: number): Promise<void> {
  const audioPeak = Number.isFinite(peak) ? Math.max(0, Math.min(1, peak)) : 0
  await editClipRecord(clipId, (clip) => ({ ...clip, audioPeak }))
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
  const tx = db.transaction('projects', 'readwrite')
  const project = await tx.store.get(projectId)
  if (!project) {
    await tx.done
    throw new Error('Project not found')
  }

  const set = new Set(project.clipIds)
  if (clipIds.length !== project.clipIds.length || clipIds.some((id) => !set.has(id))) {
    await tx.done
    throw new Error('Invalid clip order')
  }

  const updated: Project = { ...project, clipIds, updatedAt: Date.now() }
  await completeTransaction([tx.store.put(updated)], tx)
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
  const source = await getClip(clipId)
  if (!source) throw new Error('Clip not found')

  const now = Date.now()
  const [blob, thumbs, poster] = await Promise.all([
    toStoredBlob(source.blob, source.mimeType),
    source.thumbs
      ? Promise.all(source.thumbs.map((thumb) => toStoredBlob(thumb)))
      : Promise.resolve(undefined),
    source.poster ? toStoredBlob(source.poster) : Promise.resolve(undefined),
  ])

  const db = await getDb()
  const tx = db.transaction(['clips', 'media', 'projects'], 'readwrite')
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
      ...putClipRecord(tx.objectStore('clips'), tx.objectStore('media'), copy),
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

/**
 * Remove a clip from its project, keeping its media for one-step undo. Only
 * the newest deletion per project is undoable, so the media of the clip it
 * supersedes is dropped here. All reads share the writing transaction: a
 * stale project snapshot could otherwise drop a just-saved clip from
 * clipIds and strand its record.
 */
export async function deleteClip(clipId: ClipId): Promise<DeletedClipSnapshot | null> {
  const db = await getDb()
  const tx = db.transaction(['clips', 'media', 'projects', 'undo'], 'readwrite')
  const clip = await tx.objectStore('clips').get(clipId)
  const project = clip ? await tx.objectStore('projects').get(clip.projectId) : undefined
  const index = project?.clipIds.indexOf(clipId) ?? -1
  if (!clip || !project || index < 0) {
    await tx.done
    return null
  }
  const previous = await tx.objectStore('undo').get(project.id)

  const { blob: legacyBlob, ...meta } = clip
  const snapshot: DeletedClipSnapshot = { clip: meta, index, deletedAt: Date.now() }
  const media = tx.objectStore('media')
  const ops: Array<Promise<unknown>> = [
    tx.objectStore('clips').delete(clipId),
    tx.objectStore('projects').put({
      ...project,
      clipIds: project.clipIds.filter((id) => id !== clipId),
      updatedAt: Date.now(),
    }),
    tx.objectStore('undo').put(snapshot),
  ]
  if (legacyBlob) ops.push(media.put({ clipId, blob: legacyBlob }))
  if (previous && previous.clip.id !== clipId) ops.push(media.delete(previous.clip.id))
  await completeTransaction(ops, tx)
  return snapshot
}

/** Remove a clip without writing an undo snapshot — for rolling back a
 * failed split so a real prior undo is not overwritten. */
export async function discardClip(clipId: ClipId): Promise<boolean> {
  const db = await getDb()
  const tx = db.transaction(['clips', 'media', 'projects'], 'readwrite')
  const clip = await tx.objectStore('clips').get(clipId)
  const project = clip ? await tx.objectStore('projects').get(clip.projectId) : undefined
  if (!clip || !project || !project.clipIds.includes(clipId)) {
    await tx.done
    return false
  }
  await completeTransaction(
    [
      tx.objectStore('clips').delete(clipId),
      tx.objectStore('media').delete(clipId),
      tx.objectStore('projects').put({
        ...project,
        clipIds: project.clipIds.filter((id) => id !== clipId),
        updatedAt: Date.now(),
      }),
    ],
    tx,
  )
  return true
}

export async function getUndoSnapshot(projectId: ProjectId): Promise<DeletedClipSnapshot | undefined> {
  const db = await getDb()
  return db.get('undo', projectId)
}

export async function undoDeleteLastClip(projectId: ProjectId): Promise<ClipRecord | null> {
  const db = await getDb()
  const tx = db.transaction(['clips', 'media', 'projects', 'undo'], 'readwrite')
  const snapshot = await tx.objectStore('undo').get(projectId)
  const project = snapshot ? await tx.objectStore('projects').get(projectId) : undefined
  const restored = snapshot
    ? withMedia(snapshot.clip, await tx.objectStore('media').get(snapshot.clip.id))
    : undefined
  if (!snapshot || !project || !restored) {
    await tx.done
    return null
  }

  const clipIds = [...project.clipIds]
  const insertAt = Math.min(snapshot.index, clipIds.length)
  clipIds.splice(insertAt, 0, snapshot.clip.id)

  await completeTransaction(
    [
      ...putClipRecord(tx.objectStore('clips'), tx.objectStore('media'), snapshot.clip),
      tx.objectStore('projects').put({
        ...project,
        clipIds,
        updatedAt: Date.now(),
      }),
      tx.objectStore('undo').delete(projectId),
    ],
    tx,
  )
  return restored
}

/** Drop the project's undo snapshot and the deleted clip's media with it. */
export async function clearUndo(projectId: ProjectId): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['undo', 'media'], 'readwrite')
  const snapshot = await tx.objectStore('undo').get(projectId)
  if (!snapshot) {
    await tx.done
    return
  }
  await completeTransaction(
    [tx.objectStore('undo').delete(projectId), tx.objectStore('media').delete(snapshot.clip.id)],
    tx,
  )
}

export async function projectTotalDurationMs(projectId: ProjectId): Promise<number> {
  const clips = await getClipMetasForProject(projectId)
  return clips.reduce((sum, clip) => {
    const end = Math.min(clip.trimEndMs, clip.durationMs)
    const start = Math.max(0, Math.min(clip.trimStartMs, end))
    return sum + (end - start)
  }, 0)
}

function blobsBytes(blobs: ReadonlyArray<Blob | undefined>): number {
  return blobs.reduce((sum, blob) => sum + (blob?.size ?? 0), 0)
}

function clipRecordBytes(clip: StoredClipRecord): number {
  return blobsBytes([clip.blob, clip.poster, ...(clip.thumbs ?? [])])
}

export interface StorageRecords {
  projects: Project[]
  clips: StoredClipRecord[]
  media: ClipMediaRecord[]
  audio: ProjectAudioRecord[]
  undo: DeletedClipSnapshot[]
}

export interface StorageScan {
  /** Bytes each project holds: clip media and thumbnails, background
   * music, and the media kept so the last clip delete can be undone. */
  projectBytes: Map<ProjectId, number>
  /** Records no project can reach — nothing in the app can show or use
   * them, so deleting them is always safe. */
  orphans: {
    bytes: number
    clipIds: ClipId[]
    mediaIds: ClipId[]
    audioProjectIds: ProjectId[]
    undoProjectIds: ProjectId[]
  }
}

/** Attribute every stored byte to a project, or to the orphan pile. */
export function scanStorage(records: StorageRecords): StorageScan {
  const listed = new Map(records.projects.map((project) => [project.id, new Set(project.clipIds)]))
  const projectBytes = new Map<ProjectId, number>(records.projects.map((project) => [project.id, 0]))
  const mediaBytes = new Map(records.media.map((media) => [media.clipId, media.blob.size]))
  const claimedMedia = new Set<ClipId>()
  const orphans: StorageScan['orphans'] = {
    bytes: 0,
    clipIds: [],
    mediaIds: [],
    audioProjectIds: [],
    undoProjectIds: [],
  }
  const claim = (clipId: ClipId): number => {
    if (claimedMedia.has(clipId)) return 0
    claimedMedia.add(clipId)
    return mediaBytes.get(clipId) ?? 0
  }
  const addToProject = (projectId: ProjectId, bytes: number) => {
    projectBytes.set(projectId, (projectBytes.get(projectId) ?? 0) + bytes)
  }

  for (const clip of records.clips) {
    const bytes = clipRecordBytes(clip) + claim(clip.id)
    if (listed.get(clip.projectId)?.has(clip.id)) {
      addToProject(clip.projectId, bytes)
    } else {
      orphans.clipIds.push(clip.id)
      if (mediaBytes.has(clip.id)) orphans.mediaIds.push(clip.id)
      orphans.bytes += bytes
    }
  }
  for (const snapshot of records.undo) {
    const projectId = snapshot.clip.projectId
    const bytes = clipRecordBytes(snapshot.clip) + claim(snapshot.clip.id)
    if (listed.has(projectId)) {
      addToProject(projectId, bytes)
    } else {
      orphans.undoProjectIds.push(projectId)
      if (mediaBytes.has(snapshot.clip.id)) orphans.mediaIds.push(snapshot.clip.id)
      orphans.bytes += bytes
    }
  }
  for (const audio of records.audio) {
    const bytes = blobsBytes(audio.tracks.map((track) => track.blob))
    if (listed.has(audio.projectId)) {
      addToProject(audio.projectId, bytes)
    } else {
      orphans.audioProjectIds.push(audio.projectId)
      orphans.bytes += bytes
    }
  }
  for (const [clipId] of mediaBytes) {
    if (claimedMedia.has(clipId)) continue
    orphans.mediaIds.push(clipId)
    orphans.bytes += claim(clipId)
  }
  return { projectBytes, orphans }
}

const INVENTORY_STORES = ['projects', 'clips', 'media', 'audio', 'undo'] as const

async function readStorageRecords(
  tx: IDBPTransaction<ClipsDB, typeof INVENTORY_STORES, IDBTransactionMode>,
): Promise<StorageRecords> {
  const [projects, clips, media, audio, undo] = await Promise.all([
    tx.objectStore('projects').getAll(),
    tx.objectStore('clips').getAll(),
    tx.objectStore('media').getAll(),
    tx.objectStore('audio').getAll(),
    tx.objectStore('undo').getAll(),
  ])
  return { projects, clips, media, audio, undo }
}

/** Where this app's IndexedDB bytes go (Blob sizes only — no media is read). */
export async function measureStorage(): Promise<StorageScan> {
  const db = await getDb()
  const tx = db.transaction(INVENTORY_STORES)
  const records = await readStorageRecords(tx)
  await tx.done
  return scanStorage(records)
}

/**
 * Delete every record no project can reach. One transaction over every
 * store, so a clip being saved (always committed together with its
 * project's clipIds) is either fully visible or not yet there — never
 * mistaken for an orphan. Returns the bytes released.
 */
export async function reclaimOrphanedStorage(): Promise<number> {
  const db = await getDb()
  const tx = db.transaction(INVENTORY_STORES, 'readwrite')
  const { orphans } = scanStorage(await readStorageRecords(tx))
  await completeTransaction(
    [
      ...orphans.clipIds.map((id) => tx.objectStore('clips').delete(id)),
      ...orphans.mediaIds.map((id) => tx.objectStore('media').delete(id)),
      ...orphans.audioProjectIds.map((id) => tx.objectStore('audio').delete(id)),
      ...orphans.undoProjectIds.map((id) => tx.objectStore('undo').delete(id)),
    ],
    tx,
  )
  return orphans.bytes
}
