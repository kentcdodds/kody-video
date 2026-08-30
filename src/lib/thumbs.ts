import { loadClipVideo, seekTo } from './export/shared'
import { updateClipThumbs } from './storage'
import { isImageClip, type ClipRecord } from './types'

/** Filmstrip frame height: timeline tiles are 72 CSS px on up-to-3× screens. */
export const THUMB_HEIGHT = 216
export const THUMB_COUNT = 3
/** Slot poster height: the home card is ~200 CSS px tall on up-to-3× screens. */
export const POSTER_HEIGHT = 640

export interface GeneratedThumbs {
  thumbs: Blob[]
  /** High-res frame for the home slot art (same moment as thumbs[0]);
   * guaranteed present — falls back to the first filmstrip frame. */
  poster: Blob
  thumbWidth: number
  thumbHeight: number
  videoWidth: number
  videoHeight: number
}

/**
 * Capture evenly spaced poster frames for a clip. Used by the timeline so it
 * can show real filmstrip thumbnails instead of keeping a live <video>
 * decoder per clip (Android caps concurrent decoders hard), plus one
 * high-resolution poster for the home slot art.
 */
export async function generateClipThumbs(
  blob: Blob,
  count = THUMB_COUNT,
): Promise<GeneratedThumbs> {
  const loaded = await loadClipVideo(blob)
  try {
    const { video, mediaDurationMs } = loaded
    const aspect = video.videoWidth > 0 && video.videoHeight > 0
      ? video.videoWidth / video.videoHeight
      : 9 / 16
    const thumbHeight = THUMB_HEIGHT
    const thumbWidth = Math.max(2, Math.round(thumbHeight * aspect))

    const canvas = document.createElement('canvas')
    canvas.width = thumbWidth
    canvas.height = thumbHeight
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Canvas not available')

    const posterHeight = Math.min(POSTER_HEIGHT, video.videoHeight || POSTER_HEIGHT)
    const posterWidth = Math.max(2, Math.round(posterHeight * aspect))
    const posterCanvas = document.createElement('canvas')
    posterCanvas.width = posterWidth
    posterCanvas.height = posterHeight
    const posterCtx = posterCanvas.getContext('2d', { alpha: false })

    const durationSec = Math.max(0, mediaDurationMs / 1000)
    const thumbs: Blob[] = []
    let poster: Blob | null = null
    for (let i = 0; i < count; i += 1) {
      const at = durationSec > 0 ? (durationSec * (i + 0.5)) / count : 0
      await seekTo(video, at)
      if (i === 0 && posterCtx) {
        posterCtx.drawImage(video, 0, 0, posterWidth, posterHeight)
        poster = await canvasToBlob(posterCanvas, 0.82)
      }
      ctx.drawImage(video, 0, 0, thumbWidth, thumbHeight)
      const thumb = await canvasToBlob(canvas, 0.72)
      if (thumb) thumbs.push(thumb)
    }
    if (thumbs.length === 0) throw new Error('Could not capture clip thumbnails')

    return {
      thumbs,
      // A poster must always persist, or ensureClipThumbs would re-decode
      // the whole clip on every load looking for one.
      poster: poster ?? thumbs[0],
      thumbWidth,
      thumbHeight,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
    }
  } finally {
    loaded.release()
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality)
  })
}

/**
 * Thumbnails for a photo clip: one filmstrip frame (a still has no moments
 * to strip through — the single frame stretches across the tile) plus the
 * high-res poster, both drawn from one decode.
 */
export async function generateImageThumbs(blob: Blob): Promise<GeneratedThumbs> {
  const bitmap = await createImageBitmap(blob)
  try {
    if (bitmap.width <= 0 || bitmap.height <= 0) {
      throw new Error('Could not read photo')
    }
    const aspect = bitmap.width / bitmap.height
    const thumbHeight = THUMB_HEIGHT
    const thumbWidth = Math.max(2, Math.round(thumbHeight * aspect))
    const canvas = document.createElement('canvas')
    canvas.width = thumbWidth
    canvas.height = thumbHeight
    const ctx = canvas.getContext('2d', { alpha: false })

    const posterHeight = Math.min(POSTER_HEIGHT, bitmap.height)
    const posterWidth = Math.max(2, Math.round(posterHeight * aspect))
    const posterCanvas = document.createElement('canvas')
    posterCanvas.width = posterWidth
    posterCanvas.height = posterHeight
    const posterCtx = posterCanvas.getContext('2d', { alpha: false })
    if (!ctx || !posterCtx) throw new Error('Canvas not available')

    posterCtx.drawImage(bitmap, 0, 0, posterWidth, posterHeight)
    ctx.drawImage(posterCanvas, 0, 0, thumbWidth, thumbHeight)
    const [thumb, poster] = await Promise.all([
      canvasToBlob(canvas, 0.72),
      canvasToBlob(posterCanvas, 0.82),
    ])
    if (!thumb) throw new Error('Could not capture photo thumbnail')
    return {
      thumbs: [thumb],
      poster: poster ?? thumb,
      thumbWidth,
      thumbHeight,
      videoWidth: bitmap.width,
      videoHeight: bitmap.height,
    }
  } finally {
    bitmap.close()
  }
}

/**
 * Capture a poster + single filmstrip frame straight off the LIVE camera
 * preview at take end. Zero decoder cost: decoding the fresh blob in a
 * hidden <video> while the preview runs blanks the preview on many Androids
 * (the post-take black flash). The frame is drawn synchronously; only the
 * JPEG encode is async. Returns null when the preview has no frame to give.
 */
/** How long a lift-time thumb mirror may wait for its first frame. */
const LIVE_THUMB_FRAME_MS = 400

/**
 * Resolve once `video` has a paintable frame, or when `timeoutMs` elapses.
 * Used by the lift-time thumb mirror so we never read back the on-screen
 * preview (that blinks Android's overlay path).
 */
export function waitForVideoFrame(
  video: HTMLVideoElement,
  timeoutMs = LIVE_THUMB_FRAME_MS,
): Promise<boolean> {
  const hasFrame = () => video.readyState >= 2 && video.videoWidth > 0
  if (hasFrame()) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      video.removeEventListener('loadeddata', onReady)
      video.removeEventListener('canplay', onReady)
      resolve(ok)
    }
    const onReady = () => {
      if (hasFrame()) finish(true)
    }
    const timer = window.setTimeout(() => finish(hasFrame()), timeoutMs)
    video.addEventListener('loadeddata', onReady)
    video.addEventListener('canplay', onReady)
    if ('requestVideoFrameCallback' in video) {
      video.requestVideoFrameCallback(() => finish(true))
    }
    void video.play().catch(() => undefined)
  })
}

/**
 * One detached <video> on the live camera, only for the stop beat.
 * Keeping a mirror for the whole take added a third video sink beside
 * the overlay preview and the MediaRecorder clone. Attach here, wait
 * for a frame (the stop-grace window usually covers it), draw, detach.
 */
export async function captureLiveThumbsFromStream(
  stream: MediaStream | null | undefined,
  timeoutMs = LIVE_THUMB_FRAME_MS,
): Promise<GeneratedThumbs | null> {
  const track = stream?.getVideoTracks().find((item) => item.readyState === 'live')
  if (!track) return null
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = new MediaStream([track])
  try {
    const ready = await waitForVideoFrame(video, timeoutMs)
    if (!ready) return null
    return await captureLiveThumbs(video)
  } finally {
    video.srcObject = null
  }
}

export async function captureLiveThumbs(
  video: HTMLVideoElement | null,
): Promise<GeneratedThumbs | null> {
  if (!video || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
    return null
  }
  const aspect = video.videoWidth / video.videoHeight
  const thumbHeight = THUMB_HEIGHT
  const thumbWidth = Math.max(2, Math.round(thumbHeight * aspect))
  const canvas = document.createElement('canvas')
  canvas.width = thumbWidth
  canvas.height = thumbHeight
  const ctx = canvas.getContext('2d', { alpha: false })

  const posterHeight = Math.min(POSTER_HEIGHT, video.videoHeight)
  const posterWidth = Math.max(2, Math.round(posterHeight * aspect))
  const posterCanvas = document.createElement('canvas')
  posterCanvas.width = posterWidth
  posterCanvas.height = posterHeight
  const posterCtx = posterCanvas.getContext('2d', { alpha: false })
  if (!ctx || !posterCtx) return null

  try {
    // ONE video readback: pulling pixels out of a live camera element is the
    // expensive part (GPU→CPU copy), so the filmstrip thumb is scaled from
    // the poster canvas instead of a second video draw.
    posterCtx.drawImage(video, 0, 0, posterWidth, posterHeight)
    ctx.drawImage(posterCanvas, 0, 0, thumbWidth, thumbHeight)
  } catch {
    return null
  }
  const [thumb, poster] = await Promise.all([
    canvasToBlob(canvas, 0.72),
    canvasToBlob(posterCanvas, 0.82),
  ])
  if (!thumb) return null
  return {
    thumbs: [thumb],
    poster: poster ?? thumb,
    thumbWidth,
    thumbHeight,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
  }
}

const refineInFlight = new Map<string, Promise<void>>()

/**
 * Upgrade a live-captured single-frame filmstrip to the full evenly-spaced
 * strip. Only called where the camera is released (the editor), because
 * this decodes the clip — doing that behind a live preview is exactly the
 * black flash the live capture avoids.
 */
export function refineClipFilmstrip(clip: ClipRecord): Promise<void> {
  // A photo's single frame IS its finished filmstrip — nothing to refine.
  if (isImageClip(clip)) return Promise.resolve()
  const count = clip.thumbs?.length ?? 0
  if (count === 0 || count >= THUMB_COUNT) return Promise.resolve()
  if (failedThisSession.has(clip.id)) return Promise.resolve()
  const existing = refineInFlight.get(clip.id)
  if (existing) return existing

  const run = (async () => {
    try {
      let generated: GeneratedThumbs
      try {
        generated = await generateClipThumbs(clip.blob)
      } catch {
        // Undecodable media — retrying costs a media timeout every visit.
        failedThisSession.add(clip.id)
        return
      }
      // Transient persistence failure is NOT a decode failure: leave the
      // clip unmarked so a later editor visit retries the (cheap) save.
      await updateClipThumbs(clip.id, generated).catch(() => undefined)
    } finally {
      refineInFlight.delete(clip.id)
    }
  })()
  refineInFlight.set(clip.id, run)
  return run
}

const inFlight = new Map<string, Promise<ClipRecord>>()
/** Clips whose thumbnail generation failed this session — don't retry on
 * every load (an unreadable blob costs an 8s media timeout per attempt). */
const failedThisSession = new Set<string>()

/**
 * Generate and persist thumbnails for a clip that does not have them yet
 * (new recordings and clips saved before thumbnails existed).
 * Concurrent callers share the same in-flight generation.
 * Best-effort: failures leave the clip untouched.
 */
export function ensureClipThumbs(clip: ClipRecord): Promise<ClipRecord> {
  // Regenerate when the high-res poster is missing too (clips saved before
  // posters existed had only the low-res filmstrip frames).
  if (clip.thumbs && clip.thumbs.length > 0 && clip.poster) return Promise.resolve(clip)
  if (failedThisSession.has(clip.id)) return Promise.resolve(clip)
  const existing = inFlight.get(clip.id)
  if (existing) return existing

  const run = (async () => {
    try {
      let generated: GeneratedThumbs
      try {
        generated = isImageClip(clip)
          ? await generateImageThumbs(clip.blob)
          : await generateClipThumbs(clip.blob)
      } catch {
        // Unreadable/undecodable media — retrying costs an 8s timeout every
        // load, so skip this clip for the rest of the session.
        failedThisSession.add(clip.id)
        return clip
      }
      try {
        await updateClipThumbs(clip.id, generated)
      } catch {
        // Transient persistence failure: still use the thumbs in memory and
        // let a later load retry the (cheap-by-then) save.
      }
      return {
        ...clip,
        thumbs: generated.thumbs,
        poster: generated.poster,
        thumbWidth: generated.thumbWidth,
        thumbHeight: generated.thumbHeight,
        width: clip.width ?? generated.videoWidth,
        height: clip.height ?? generated.videoHeight,
      }
    } finally {
      inFlight.delete(clip.id)
    }
  })()

  inFlight.set(clip.id, run)
  return run
}
