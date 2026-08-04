import { addClip, clearUndo } from './storage'
import type { ClipRecord, ProjectId } from './types'

/** Accept string for `<input type="file">` — common phone/desktop video types. */
export const DEVICE_CLIP_ACCEPT =
  'video/*,video/mp4,video/webm,video/quicktime,video/x-matroska,.mp4,.m4v,.webm,.mov,.mkv'

export interface DeviceClipProbe {
  blob: Blob
  mimeType: string
  durationMs: number
  width?: number
  height?: number
  createdAt: number
}

export interface DeviceClipImportFailure {
  name: string
  reason: string
}

export interface DeviceClipImportResult {
  added: ClipRecord[]
  failed: DeviceClipImportFailure[]
}

/**
 * Infer a playable MIME type for a picked gallery/file. Empty `File.type` is
 * common on Android content URIs and desktop picks that only carry an
 * extension — Safari rejects `application/octet-stream` object URLs later.
 */
export function mimeTypeForDeviceFile(file: Pick<File, 'name' | 'type'>): string {
  const typed = (file.type || '').trim().toLowerCase()
  if (typed.startsWith('video/')) return typed
  const name = file.name.toLowerCase()
  if (name.endsWith('.webm')) return 'video/webm'
  if (name.endsWith('.mov')) return 'video/quicktime'
  if (name.endsWith('.mkv')) return 'video/x-matroska'
  if (name.endsWith('.m4v') || name.endsWith('.mp4')) return 'video/mp4'
  // Last resort: assume MP4 (most phone library exports). Empty type alone is
  // not enough to reject — the probe decides playability.
  return typed || 'video/mp4'
}

export function isLikelyVideoFile(file: Pick<File, 'name' | 'type'>): boolean {
  const typed = (file.type || '').trim().toLowerCase()
  if (typed.startsWith('video/')) return true
  if (typed && !typed.startsWith('application/octet-stream')) return false
  return /\.(mp4|m4v|webm|mov|mkv)$/i.test(file.name)
}

/**
 * Materialize bytes and resolve duration/dimensions. File-backed blobs from
 * the picker must be copied before IndexedDB persistence — Chromium stores
 * references to the underlying file (esp. Android content URIs), which go
 * stale after the picker closes.
 */
export async function probeDeviceClip(
  file: File,
  timeoutMs = 15_000,
): Promise<DeviceClipProbe> {
  if (file.size <= 0) {
    throw new Error('That file is empty')
  }
  if (!isLikelyVideoFile(file)) {
    throw new Error('Pick a video file')
  }

  const mimeType = mimeTypeForDeviceFile(file)
  const bytes = await file.arrayBuffer()
  const blob = new Blob([bytes], { type: mimeType })
  const createdAt =
    Number.isFinite(file.lastModified) && file.lastModified > 0
      ? file.lastModified
      : Date.now()

  // Prefer container demux (no hardware decoder). Falls back to a media
  // element when mediabunny cannot parse the file.
  try {
    const { ALL_FORMATS, BlobSource, Input } = await import('mediabunny')
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
    const seconds = await Promise.race([
      input.computeDuration(),
      new Promise<number>((_, reject) => {
        window.setTimeout(() => reject(new Error('Demux duration timed out')), timeoutMs)
      }),
    ])
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error('Could not read video duration')
    }
    const track = await input.getPrimaryVideoTrack().catch(() => null)
    const width =
      track && track.displayWidth > 0
        ? track.displayWidth
        : track && track.codedWidth > 0
          ? track.codedWidth
          : undefined
    const height =
      track && track.displayHeight > 0
        ? track.displayHeight
        : track && track.codedHeight > 0
          ? track.codedHeight
          : undefined
    if (!width || !height) {
      throw new Error('No video track')
    }
    return {
      blob,
      mimeType,
      durationMs: Math.round(seconds * 1000),
      width,
      height,
      createdAt,
    }
  } catch {
    const { loadClipVideo } = await import('./export/shared')
    const loaded = await loadClipVideo(blob, timeoutMs, mimeType)
    try {
      if (loaded.mediaDurationMs <= 0) {
        throw new Error('Could not read video duration')
      }
      const width = loaded.video.videoWidth
      const height = loaded.video.videoHeight
      if (width <= 0 || height <= 0) {
        throw new Error('No video track')
      }
      return {
        blob,
        mimeType,
        durationMs: loaded.mediaDurationMs,
        width,
        height,
        createdAt,
      }
    } finally {
      loaded.release()
    }
  }
}

/** Append one device file as a timeline clip. */
export async function importDeviceClip(
  projectId: ProjectId,
  file: File,
): Promise<ClipRecord> {
  const probed = await probeDeviceClip(file)
  return addClip({
    projectId,
    blob: probed.blob,
    mimeType: probed.mimeType,
    durationMs: probed.durationMs,
    width: probed.width,
    height: probed.height,
    createdAt: probed.createdAt,
  })
}

/**
 * Append one or more device videos to a project. Failures on individual
 * files are collected so a bad pick in a multi-select does not block the
 * rest. Clears the delete-undo stack after any successful add (same as a
 * fresh recording).
 */
export async function importDeviceClips(
  projectId: ProjectId,
  files: Iterable<File>,
  onProgress?: (done: number, total: number) => void,
): Promise<DeviceClipImportResult> {
  const list = [...files]
  const added: ClipRecord[] = []
  const failed: DeviceClipImportFailure[] = []
  onProgress?.(0, list.length)

  for (let i = 0; i < list.length; i += 1) {
    const file = list[i]!
    try {
      added.push(await importDeviceClip(projectId, file))
    } catch (error) {
      failed.push({
        name: file.name || 'clip',
        reason: error instanceof Error ? error.message : 'Could not import',
      })
    }
    onProgress?.(i + 1, list.length)
  }

  if (added.length > 0) {
    await clearUndo(projectId)
  }
  return { added, failed }
}
