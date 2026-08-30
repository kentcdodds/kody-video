import { isWatermarkRemoved } from './entitlement'
import {
  addClip,
  addProjectAudioTrack,
  createProject,
  deleteProject,
  isQuotaExceededError,
  StorageQuotaExceededError,
  throwMappedStorageWriteError,
  updateClipTrim,
  updateProjectAudioTrack,
} from './storage'
import {
  availableBytes,
  backupFitsStorage,
  estimateStorageSpace,
  formatBytes,
  requestPersistentStorage,
} from './storage-space'
import {
  clampImageDurationMs,
  type ClipRecord,
  type Project,
  type ProjectAudioRecord,
  type ProjectOrientation,
} from './types'

/**
 * Single-file project backup, used both as a safety net and to move a
 * project between devices or browser origins (storage is per-origin — e.g.
 * an older deploy → kody.video).
 *
 * Format: `KODYVID1` magic, u32 big-endian JSON manifest length, UTF-8 JSON
 * manifest, then every clip's media bytes concatenated in manifest order,
 * then (when present) the background-audio track's bytes. Older app
 * versions ignore the unknown manifest fields and the trailing audio bytes,
 * so music-carrying backups still import there (clips only).
 * Thumbnails are intentionally excluded — the loader regenerates them.
 */
const MAGIC = 'KODYVID1'
const MAGIC_BYTES = new TextEncoder().encode(MAGIC)

interface ManifestClip {
  mimeType: string
  /** 'image' for a still photo shown for durationMs (absent = video).
   * Older app versions ignore this field; the media bytes then fail their
   * video probe on playback rather than corrupting the import. */
  kind?: 'image'
  durationMs: number
  trimStartMs: number
  trimEndMs: number
  createdAt: number
  width?: number
  height?: number
  lat?: number
  lng?: number
  locationAccuracyM?: number
  /** The clip's own (foreground) sound level override (0–1). */
  clipVolume?: number
  /** Background-music level override (0–1) while this clip plays. */
  musicVolume?: number
  /** Measured whole-clip audio peak (0–1) — restored so imported clips
   * skip the normalization re-measure on their first load. */
  audioPeak?: number
  /** Byte length of this clip's media in the blob section. */
  byteLength: number
}

interface ManifestAudioTrack {
  mimeType: string
  durationMs: number
  name: string
  /** Per-track playback settings (absent = whole track, full level,
   * playlist-default fades). Older app versions ignore these. */
  trimStartMs?: number
  trimEndMs?: number
  volume?: number
  fadeIn?: boolean
  fadeOut?: boolean
  /** Byte length of this track, appended after every clip's media bytes
   * (tracks follow in playlist order). */
  byteLength: number
}

interface ManifestAudio {
  fadeIn: boolean
  fadeOut: boolean
  tracks: ManifestAudioTrack[]
}

interface Manifest {
  version: 1
  app: 'kody-video'
  exportedAt: number
  projectName: string
  /** The film's orientation (absent = portrait). Older app versions ignore
   * this field and import the clips as a portrait project. */
  orientation?: 'landscape'
  clips: ManifestClip[]
  /** Background-music playlist (absent on projects without one). */
  audio?: ManifestAudio
}

export const KODY_VIDEO_BACKUP_EXTENSION = '.kodyvideo'

export function projectBackupFilename(projectName: string): string {
  const slug =
    projectName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 40) || 'project'
  return `${slug}${KODY_VIDEO_BACKUP_EXTENSION}`
}

/** True when the picked/dropped file uses the Kody Video backup extension. */
export function isKodyVideoBackupFile(file: Pick<File, 'name'>): boolean {
  return file.name.toLowerCase().endsWith(KODY_VIDEO_BACKUP_EXTENSION)
}

/** Backup files from a picker or drop, in the order they were supplied. */
export function kodyVideoBackupFilesFromList(
  files: Iterable<File> | ArrayLike<File> | null | undefined,
): File[] {
  if (!files) return []
  return Array.from(files).filter(isKodyVideoBackupFile)
}

/** True when a drag payload may contain OS files (names are hidden until drop). */
export function dataTransferHasFiles(dataTransfer: DataTransfer | null | undefined): boolean {
  return Boolean(dataTransfer?.types.includes('Files'))
}

/** Bundle a project into one shareable/downloadable backup Blob. */
export function serializeProject(
  project: Project,
  clips: ClipRecord[],
  audio?: ProjectAudioRecord | null,
): Blob {
  const manifest: Manifest = {
    version: 1,
    app: 'kody-video',
    exportedAt: Date.now(),
    projectName: project.name,
    ...(project.orientation === 'landscape' ? { orientation: 'landscape' as const } : {}),
    clips: clips.map((clip) => ({
      mimeType: clip.mimeType,
      ...(clip.kind === 'image' ? { kind: 'image' as const } : {}),
      durationMs: clip.durationMs,
      trimStartMs: clip.trimStartMs,
      trimEndMs: clip.trimEndMs,
      createdAt: clip.createdAt,
      width: clip.width,
      height: clip.height,
      lat: clip.lat,
      lng: clip.lng,
      locationAccuracyM: clip.locationAccuracyM,
      clipVolume: clip.clipVolume,
      musicVolume: clip.musicVolume,
      audioPeak: clip.audioPeak,
      byteLength: clip.blob.size,
    })),
  }
  if (audio && audio.tracks.length > 0) {
    manifest.audio = {
      fadeIn: audio.fadeIn,
      fadeOut: audio.fadeOut,
      tracks: audio.tracks.map((track) => ({
        mimeType: track.mimeType,
        durationMs: track.durationMs,
        name: track.name,
        trimStartMs: track.trimStartMs,
        trimEndMs: track.trimEndMs,
        volume: track.volume,
        fadeIn: track.fadeIn,
        fadeOut: track.fadeOut,
        byteLength: track.blob.size,
      })),
    }
  }

  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
  const header = new Uint8Array(MAGIC_BYTES.byteLength + 4)
  header.set(MAGIC_BYTES, 0)
  new DataView(header.buffer).setUint32(MAGIC_BYTES.byteLength, manifestBytes.byteLength)

  // Blob composition references the clip blobs — nothing is copied here.
  return new Blob(
    [
      header,
      manifestBytes,
      ...clips.map((clip) => clip.blob),
      ...(audio?.tracks.map((track) => track.blob) ?? []),
    ],
    { type: 'application/octet-stream' },
  )
}

export interface ParsedBackupAudio {
  fadeIn: boolean
  fadeOut: boolean
  tracks: Array<Omit<ManifestAudioTrack, 'byteLength'> & { blob: Blob }>
}

export interface ParsedBackup {
  projectName: string
  /** The film's orientation ('portrait' when the backup carries none). */
  orientation: ProjectOrientation
  clips: Array<Omit<ManifestClip, 'byteLength'> & { blob: Blob }>
  /** Background-music playlist, when the backup carries one. */
  audio: ParsedBackupAudio | null
}

/**
 * A file the user picked that isn't a (valid, current) Kody Video backup.
 * Surfaced in-app as guidance; expected user input, never a crash report.
 */
export class BackupFormatError extends Error {
  override readonly name = 'BackupFormatError'
}

/**
 * Parse a backup file. Media bytes are sliced lazily per clip (File.slice),
 * so large backups never need the whole file in memory at once.
 */
export async function parseProjectBackup(file: Blob): Promise<ParsedBackup> {
  const headerLength = MAGIC_BYTES.byteLength + 4
  if (file.size < headerLength) throw new BackupFormatError('Not a Kody Video backup file')

  const header = new Uint8Array(await file.slice(0, headerLength).arrayBuffer())
  for (let i = 0; i < MAGIC_BYTES.byteLength; i += 1) {
    if (header[i] !== MAGIC_BYTES[i]) throw new BackupFormatError('Not a Kody Video backup file')
  }
  const manifestLength = new DataView(header.buffer).getUint32(MAGIC_BYTES.byteLength)
  if (manifestLength <= 0 || headerLength + manifestLength > file.size) {
    throw new BackupFormatError('This backup file is damaged')
  }

  let manifest: Manifest
  try {
    const manifestBytes = await file
      .slice(headerLength, headerLength + manifestLength)
      .arrayBuffer()
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest
  } catch {
    throw new BackupFormatError('This backup file is damaged')
  }
  if (manifest.app !== 'kody-video' || manifest.version !== 1 || !Array.isArray(manifest.clips)) {
    throw new BackupFormatError('This backup was made by a newer app version — update and retry')
  }

  let offset = headerLength + manifestLength
  const clips: ParsedBackup['clips'] = []
  for (const clip of manifest.clips) {
    if (
      !Number.isInteger(clip.byteLength) ||
      clip.byteLength <= 0 ||
      offset + clip.byteLength > file.size
    ) {
      throw new BackupFormatError('This backup file is damaged')
    }
    const mimeType = typeof clip.mimeType === 'string' ? clip.mimeType : 'video/webm'
    clips.push({
      mimeType,
      ...(clip.kind === 'image' ? { kind: 'image' as const } : {}),
      durationMs: clip.durationMs,
      trimStartMs: clip.trimStartMs,
      trimEndMs: clip.trimEndMs,
      createdAt: clip.createdAt,
      width: clip.width,
      height: clip.height,
      lat: clip.lat,
      lng: clip.lng,
      locationAccuracyM: clip.locationAccuracyM,
      // Old backups carried an `audioVolume` mix share instead — ignored.
      clipVolume: typeof clip.clipVolume === 'number' ? clip.clipVolume : undefined,
      musicVolume: typeof clip.musicVolume === 'number' ? clip.musicVolume : undefined,
      audioPeak:
        typeof clip.audioPeak === 'number' && Number.isFinite(clip.audioPeak)
          ? Math.max(0, Math.min(1, clip.audioPeak))
          : undefined,
      blob: file.slice(offset, offset + clip.byteLength, mimeType),
    })
    offset += clip.byteLength
  }

  let audio: ParsedBackup['audio'] = null
  const manifestAudio = manifest.audio
  if (manifestAudio && Array.isArray(manifestAudio.tracks) && manifestAudio.tracks.length > 0) {
    const tracks: ParsedBackupAudio['tracks'] = []
    for (const track of manifestAudio.tracks) {
      if (
        !Number.isInteger(track.byteLength) ||
        track.byteLength <= 0 ||
        offset + track.byteLength > file.size ||
        !Number.isFinite(track.durationMs) ||
        track.durationMs <= 0
      ) {
        throw new BackupFormatError('This backup file is damaged')
      }
      const mimeType = typeof track.mimeType === 'string' ? track.mimeType : 'audio/mpeg'
      const finiteOrUndefined = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
      tracks.push({
        mimeType,
        durationMs: track.durationMs,
        name: String(track.name || 'Audio track'),
        trimStartMs: finiteOrUndefined(track.trimStartMs),
        trimEndMs: finiteOrUndefined(track.trimEndMs),
        volume: finiteOrUndefined(track.volume),
        fadeIn: typeof track.fadeIn === 'boolean' ? track.fadeIn : undefined,
        fadeOut: typeof track.fadeOut === 'boolean' ? track.fadeOut : undefined,
        blob: file.slice(offset, offset + track.byteLength, mimeType),
      })
      offset += track.byteLength
    }
    audio = {
      fadeIn: manifestAudio.fadeIn !== false,
      fadeOut: manifestAudio.fadeOut !== false,
      tracks,
    }
  }

  return {
    projectName: String(manifest.projectName || 'Imported project'),
    orientation: manifest.orientation === 'landscape' ? 'landscape' : 'portrait',
    clips,
    audio,
  }
}

let importLock: Promise<void> = Promise.resolve()

/** Test-only: drop a hung lock so browser-mode cases start independent. */
export function __resetProjectTransferForTests(): void {
  importLock = Promise.resolve()
}

async function withImportLock<T>(run: () => Promise<T>): Promise<T> {
  const previous = importLock
  let release!: () => void
  importLock = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await run()
  } finally {
    release()
  }
}

function assertImportableClip(clip: ParsedBackup['clips'][number]): void {
  const finite =
    Number.isFinite(clip.durationMs) &&
    Number.isFinite(clip.trimStartMs) &&
    Number.isFinite(clip.trimEndMs) &&
    Number.isFinite(clip.createdAt)
  if (!finite || clip.durationMs <= 0 || clip.blob.size <= 0) {
    throw new BackupFormatError('This backup file is damaged')
  }
}

/**
 * Refuse an import when the remaining origin quota cannot hold the file.
 * Missing estimates skip the gate (the write still has a quota catch).
 */
export async function assertBackupFitsStorage(backupBytes: number): Promise<void> {
  await requestPersistentStorage()
  const space = await estimateStorageSpace()
  if (backupFitsStorage(backupBytes, space)) return
  const free = availableBytes(space)
  throw new StorageQuotaExceededError(
    `This backup is ${formatBytes(backupBytes)} and this device has ${formatBytes(free)} free. Delete a project or clear cached exports, then try again.`,
  )
}

/**
 * QuotaExceededError during a giant File copy is often a RAM allocation
 * refusal, not a full disk. If the estimate still shows room for the
 * backup, say that instead of "Device storage is full".
 */
async function throwImportWriteError(error: unknown, backupBytes: number): Promise<never> {
  if (isQuotaExceededError(error) || error instanceof StorageQuotaExceededError) {
    const space = await estimateStorageSpace()
    if (space && availableBytes(space) > backupBytes) {
      throw new BackupCopyError(
        'The browser could not copy this backup into on-device storage. Try again, or import on a computer (Chrome works best).',
      )
    }
    if (error instanceof StorageQuotaExceededError) throw error
    throw new StorageQuotaExceededError()
  }
  throwMappedStorageWriteError(error)
}

/**
 * A write failed even though the disk estimate still has room — usually a
 * huge in-memory copy the browser refused. Expected; not a crash report.
 */
export class BackupCopyError extends Error {
  override readonly name = 'BackupCopyError'
}

/**
 * Parse a backup file and persist it as a new project. Requests persistent
 * storage first so a large write is less likely to hit a temporary quota.
 */
export async function importKodyVideoBackupFile(
  file: File,
  onProgress?: (doneClips: number, totalClips: number) => void,
): Promise<Project> {
  await assertBackupFitsStorage(file.size)
  const parsed = await parseProjectBackup(file)
  try {
    return await importProjectBackup(parsed, onProgress)
  } catch (error) {
    return await throwImportWriteError(error, file.size)
  }
}

/** Create a fresh project (new ids) from a parsed backup. */
export async function importProjectBackup(
  parsed: ParsedBackup,
  onProgress?: (doneClips: number, totalClips: number) => void,
): Promise<Project> {
  return withImportLock(() => persistImportedProject(parsed, onProgress))
}

async function persistImportedProject(
  parsed: ParsedBackup,
  onProgress?: (doneClips: number, totalClips: number) => void,
): Promise<Project> {
  const plus = await isWatermarkRemoved()
  // Landscape projects are a Plus perk, like background music: restoring a
  // Plus-made backup on a free device keeps the clips as a portrait project
  // (the setting is skipped, never a creation failure).
  const orientation = plus && parsed.orientation === 'landscape' ? 'landscape' : undefined
  const project = await createProject(parsed.projectName, { orientation })
  try {
    let done = 0
    onProgress?.(0, parsed.clips.length)
    for (const clip of parsed.clips) {
      assertImportableClip(clip)
      // Pass the File.slice straight to addClip — toStoredBlob copies it
      // in chunks so a ~1GB clip never needs one giant ArrayBuffer (that
      // throw was remapped to "Device storage is full" even with room).
      const isImage = clip.kind === 'image'
      const added = await addClip({
        projectId: project.id,
        blob: clip.blob,
        mimeType: clip.mimeType,
        kind: clip.kind,
        // Photo durations re-clamp into the supported range on the way in.
        durationMs: isImage ? clampImageDurationMs(clip.durationMs) : clip.durationMs,
        // Keep the original capture time so chapter titles stay truthful.
        createdAt: clip.createdAt,
        width: clip.width,
        height: clip.height,
        lat: clip.lat,
        lng: clip.lng,
        locationAccuracyM: clip.locationAccuracyM,
        clipVolume: clip.clipVolume,
        musicVolume: clip.musicVolume,
        // Photos are silent by construction.
        audioPeak: isImage ? (clip.audioPeak ?? 0) : clip.audioPeak,
      })
      // Restore trims (addClip resets them to the full clip). A photo shows
      // in full by definition — its trim window IS its duration.
      const trimmed = isImage
        ? added
        : await updateClipTrim(added.id, clip.trimStartMs, clip.trimEndMs)
      // Generate thumbnails now so the slot poster shows right away and the
      // first open doesn't pay the backfill cost. Lazy import keeps mediabunny
      // out of the home-shell graph until an import actually runs.
      const { ensureClipThumbs } = await import('./thumbs')
      await ensureClipThumbs({ ...added, ...trimmed, blob: added.blob }).catch(() => undefined)
      done += 1
      onProgress?.(done, parsed.clips.length)
    }
    // Background music is a Plus perk: restoring a Plus-made backup on a
    // free device keeps the clips and skips the playlist wholesale (checked
    // up front — never a silent partial playlist). On entitled devices any
    // track failure fails the import like a clip failure would, so the
    // rollback below never leaves half the music behind.
    if (parsed.audio && plus) {
      for (const track of parsed.audio.tracks) {
        const record = await addProjectAudioTrack({
          projectId: project.id,
          blob: track.blob,
          mimeType: track.mimeType,
          durationMs: track.durationMs,
          name: track.name,
          // Playlist settings land with the first track; later adds keep them.
          fadeIn: parsed.audio.fadeIn,
          fadeOut: parsed.audio.fadeOut,
        })
        // Restore the track's own playback settings (trim, level, fades).
        if (
          track.trimStartMs !== undefined ||
          track.trimEndMs !== undefined ||
          track.volume !== undefined ||
          track.fadeIn !== undefined ||
          track.fadeOut !== undefined
        ) {
          await updateProjectAudioTrack(project.id, record.tracks.at(-1)!.id, {
            trimStartMs: track.trimStartMs,
            trimEndMs: track.trimEndMs,
            volume: track.volume,
            fadeIn: track.fadeIn,
            fadeOut: track.fadeOut,
          })
        }
      }
    }
    return project
  } catch (error) {
    // Never leave a half-imported project behind.
    await deleteProject(project.id).catch(() => undefined)
    throw error
  }
}
