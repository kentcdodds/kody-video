import { loadClipVideo, seekTo } from './export/shared'
import { updateClipThumbs } from './storage'
import type { ClipRecord } from './types'

/** Filmstrip frame height: timeline tiles are 72 CSS px on up-to-3× screens. */
export const THUMB_HEIGHT = 216
export const THUMB_COUNT = 3
/** Slot poster height: the home card is ~200 CSS px tall on up-to-3× screens. */
export const POSTER_HEIGHT = 640

export interface GeneratedThumbs {
  thumbs: Blob[]
  /** High-res frame for the home slot art (same moment as thumbs[0]). */
  poster: Blob | null
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
      poster,
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
        generated = await generateClipThumbs(clip.blob)
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
        poster: generated.poster ?? clip.poster,
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
