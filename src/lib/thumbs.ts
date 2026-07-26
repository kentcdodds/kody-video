import { loadClipVideo, seekTo } from './export/shared'
import { updateClipThumbs } from './storage'
import type { ClipRecord } from './types'

export const THUMB_HEIGHT = 120
export const THUMB_COUNT = 3

export interface GeneratedThumbs {
  thumbs: Blob[]
  thumbWidth: number
  thumbHeight: number
  videoWidth: number
  videoHeight: number
}

/**
 * Capture evenly spaced poster frames for a clip. Used by the timeline so it
 * can show real filmstrip thumbnails instead of keeping a live <video>
 * decoder per clip (Android caps concurrent decoders hard).
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

    const durationSec = Math.max(0, mediaDurationMs / 1000)
    const thumbs: Blob[] = []
    for (let i = 0; i < count; i += 1) {
      const at = durationSec > 0 ? (durationSec * (i + 0.5)) / count : 0
      await seekTo(video, at)
      ctx.drawImage(video, 0, 0, thumbWidth, thumbHeight)
      const thumb = await canvasToBlob(canvas)
      if (thumb) thumbs.push(thumb)
    }
    if (thumbs.length === 0) throw new Error('Could not capture clip thumbnails')

    return {
      thumbs,
      thumbWidth,
      thumbHeight,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
    }
  } finally {
    loaded.release()
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.72)
  })
}

const inFlight = new Map<string, Promise<ClipRecord>>()

/**
 * Generate and persist thumbnails for a clip that does not have them yet
 * (new recordings and clips saved before thumbnails existed).
 * Concurrent callers share the same in-flight generation.
 * Best-effort: failures leave the clip untouched.
 */
export function ensureClipThumbs(clip: ClipRecord): Promise<ClipRecord> {
  if (clip.thumbs && clip.thumbs.length > 0) return Promise.resolve(clip)
  const existing = inFlight.get(clip.id)
  if (existing) return existing

  const run = (async () => {
    try {
      const generated = await generateClipThumbs(clip.blob)
      await updateClipThumbs(clip.id, generated)
      return {
        ...clip,
        thumbs: generated.thumbs,
        thumbWidth: generated.thumbWidth,
        thumbHeight: generated.thumbHeight,
        width: clip.width ?? generated.videoWidth,
        height: clip.height ?? generated.videoHeight,
      }
    } catch {
      return clip
    } finally {
      inFlight.delete(clip.id)
    }
  })()

  inFlight.set(clip.id, run)
  return run
}
