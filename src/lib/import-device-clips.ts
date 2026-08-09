import { addClip, clearUndo } from './storage'
import { DEFAULT_IMAGE_DURATION_MS, type ClipKind, type ClipRecord, type ProjectId } from './types'

/** Accept string for `<input type="file">` — common phone/desktop video
 * types, plus photos (added to the timeline as stills with a chosen
 * on-screen duration). */
export const DEVICE_CLIP_ACCEPT =
  'video/*,video/mp4,video/webm,video/quicktime,video/x-matroska,.mp4,.m4v,.webm,.mov,.mkv,' +
  'image/*,image/jpeg,image/png,image/webp,image/gif,image/avif,.jpg,.jpeg,.png,.webp,.gif,.avif,.bmp,.heic,.heif'

export interface DeviceClipProbe {
  blob: Blob
  mimeType: string
  kind?: ClipKind
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
  // Reject clear non-video MIME types. Empty type / octet-stream is common for
  // Android content-URI picks (often extension-less names like "content") —
  // let probeDeviceClip decide playability for those.
  if (typed && !typed.startsWith('application/octet-stream')) return false
  return true
}

const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|gif|avif|bmp|heic|heif)$/

/**
 * Infer a MIME type for a picked photo. Like videos, empty `File.type` is
 * common for Android content URIs — fall back to the extension.
 */
export function mimeTypeForDeviceImage(file: Pick<File, 'name' | 'type'>): string {
  const typed = (file.type || '').trim().toLowerCase()
  if (typed.startsWith('image/')) return typed
  const name = file.name.toLowerCase()
  if (name.endsWith('.png')) return 'image/png'
  if (name.endsWith('.webp')) return 'image/webp'
  if (name.endsWith('.gif')) return 'image/gif'
  if (name.endsWith('.avif')) return 'image/avif'
  if (name.endsWith('.bmp')) return 'image/bmp'
  if (name.endsWith('.heic')) return 'image/heic'
  if (name.endsWith('.heif')) return 'image/heif'
  return 'image/jpeg'
}

/** True when a pick should take the photo import path (checked before the
 * video path — an image type or extension is unambiguous). */
export function isLikelyImageFile(file: Pick<File, 'name' | 'type'>): boolean {
  const typed = (file.type || '').trim().toLowerCase()
  if (typed.startsWith('image/')) return true
  if (typed && !typed.startsWith('application/octet-stream')) return false
  return IMAGE_EXTENSIONS.test(file.name.toLowerCase())
}

async function demuxClipMeta(
  blob: Blob,
  timeoutMs: number,
): Promise<{ durationMs: number; width: number; height: number }> {
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
        : 0
  const height =
    track && track.displayHeight > 0
      ? track.displayHeight
      : track && track.codedHeight > 0
        ? track.codedHeight
        : 0
  if (width <= 0 || height <= 0) {
    throw new Error('No video track')
  }
  return { durationMs: Math.round(seconds * 1000), width, height }
}

/**
 * Materialize a picked photo's bytes and prove this browser can decode it
 * (an undecodable format must fail the pick, not the export). Stills enter
 * the timeline with the default on-screen duration — the editor's duration
 * strip adjusts it afterward.
 */
export async function probeDeviceImage(file: File): Promise<DeviceClipProbe> {
  if (file.size <= 0) {
    throw new Error('That file is empty')
  }
  const mimeType = mimeTypeForDeviceImage(file)
  const bytes = await file.arrayBuffer()
  const blob = new Blob([bytes], { type: mimeType })
  const createdAt =
    Number.isFinite(file.lastModified) && file.lastModified > 0
      ? file.lastModified
      : Date.now()

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob)
  } catch {
    throw new Error('This browser cannot read that photo format')
  }
  try {
    if (bitmap.width <= 0 || bitmap.height <= 0) {
      throw new Error('This browser cannot read that photo format')
    }
    return {
      blob,
      mimeType,
      kind: 'image',
      durationMs: DEFAULT_IMAGE_DURATION_MS,
      width: bitmap.width,
      height: bitmap.height,
      createdAt,
    }
  } finally {
    bitmap.close()
  }
}

/**
 * Materialize bytes and resolve duration/dimensions. File-backed blobs from
 * the picker must be copied before IndexedDB persistence — Chromium stores
 * references to the underlying file (esp. Android content URIs), which go
 * stale after the picker closes.
 *
 * Demux is preferred for metadata, but the browser must still be able to
 * decode the clip (unsupported codecs would otherwise persist and fail in
 * preview/export).
 */
export async function probeDeviceClip(
  file: File,
  timeoutMs = 15_000,
): Promise<DeviceClipProbe> {
  if (file.size <= 0) {
    throw new Error('That file is empty')
  }
  if (isLikelyImageFile(file)) {
    return probeDeviceImage(file)
  }
  if (!isLikelyVideoFile(file)) {
    throw new Error('Pick a video or photo file')
  }

  const mimeType = mimeTypeForDeviceFile(file)
  const bytes = await file.arrayBuffer()
  const blob = new Blob([bytes], { type: mimeType })
  const createdAt =
    Number.isFinite(file.lastModified) && file.lastModified > 0
      ? file.lastModified
      : Date.now()

  let demuxMeta: { durationMs: number; width: number; height: number } | null = null
  try {
    demuxMeta = await demuxClipMeta(blob, timeoutMs)
  } catch {
    demuxMeta = null
  }

  // Prove the browser can decode before we persist — demux alone accepts
  // containers whose video codec this device cannot play.
  const { loadClipVideo } = await import('./export/shared')
  const loaded = await loadClipVideo(blob, timeoutMs, mimeType)
  try {
    const durationMs =
      demuxMeta?.durationMs && demuxMeta.durationMs > 0
        ? demuxMeta.durationMs
        : loaded.mediaDurationMs
    const width =
      demuxMeta?.width && demuxMeta.width > 0 ? demuxMeta.width : loaded.video.videoWidth
    const height =
      demuxMeta?.height && demuxMeta.height > 0 ? demuxMeta.height : loaded.video.videoHeight
    if (durationMs <= 0) {
      throw new Error('Could not read video duration')
    }
    if (width <= 0 || height <= 0) {
      throw new Error('No video track')
    }
    return {
      blob,
      mimeType,
      durationMs,
      width,
      height,
      createdAt,
    }
  } finally {
    loaded.release()
  }
}

/** Append one device file as a timeline clip. */
export async function importDeviceClip(
  projectId: ProjectId,
  file: File,
): Promise<ClipRecord> {
  const probed = await probeDeviceClip(file)
  return addClip(addClipInputFor(projectId, probed))
}

function addClipInputFor(
  projectId: ProjectId,
  probed: DeviceClipProbe,
): Parameters<typeof addClip>[0] {
  return {
    projectId,
    blob: probed.blob,
    mimeType: probed.mimeType,
    kind: probed.kind,
    durationMs: probed.durationMs,
    width: probed.width,
    height: probed.height,
    createdAt: probed.createdAt,
    // Photos are silent by construction — persist the zero measurement so
    // the loader backfill never attempts an audio decode on them.
    ...(probed.kind === 'image' ? { audioPeak: 0 } : {}),
  }
}

export interface ImportDeviceClipsOptions {
  /** Lazily create/resolve the project only after the first file probes OK —
   * so a failed pick on `/project/new` does not burn a free project slot. */
  ensureProjectId: () => Promise<ProjectId>
  onProgress?: (done: number, total: number) => void
}

/**
 * Append one or more device videos to a project. Failures on individual
 * files are collected so a bad pick in a multi-select does not block the
 * rest. Clears the delete-undo stack after any successful add (same as a
 * fresh recording).
 */
export async function importDeviceClips(
  files: Iterable<File>,
  options: ImportDeviceClipsOptions,
): Promise<DeviceClipImportResult> {
  const list = [...files]
  const added: ClipRecord[] = []
  const failed: DeviceClipImportFailure[] = []
  let projectId: ProjectId | null = null
  options.onProgress?.(0, list.length)

  for (let i = 0; i < list.length; i += 1) {
    const file = list[i]!
    try {
      const probed = await probeDeviceClip(file)
      projectId ??= await options.ensureProjectId()
      added.push(await addClip(addClipInputFor(projectId, probed)))
    } catch (error) {
      failed.push({
        name: file.name || 'clip',
        reason: error instanceof Error ? error.message : 'Could not import',
      })
    }
    options.onProgress?.(i + 1, list.length)
  }

  if (added.length > 0 && projectId) {
    await clearUndo(projectId)
  }
  return { added, failed }
}
