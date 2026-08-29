import { isImageClip, type ClipRecord } from './types'
import { VIDEO_QUALITY_PRESETS, videoBitrateFor } from './video-quality'

export interface ClipQualityReduction {
  /** User-facing size/bitrate label for the confirm copy. */
  summary: string
  width: number
  height: number
  bitrate: number
}

const STANDARD_LONG_EDGE = VIDEO_QUALITY_PRESETS.standard.longEdge
const SAVER_BPP = VIDEO_QUALITY_PRESETS.saver.captureBpp
/** Leave headroom so a just-barely-richer file still shrinks. */
const SHRINK_RATIO = 0.65
const ALREADY_SMALL_RATIO = 0.9

function even(n: number): number {
  return Math.max(2, 2 * Math.round(n / 2))
}

export function scaleToLongEdge(
  width: number,
  height: number,
  longEdge: number,
): { width: number; height: number } {
  const w = width > 0 ? width : longEdge
  const h = height > 0 ? height : longEdge
  const current = Math.max(w, h)
  if (current <= longEdge) return { width: even(w), height: even(h) }
  const scale = longEdge / current
  return { width: even(w * scale), height: even(h * scale) }
}

export function estimatedClipBitsPerSecond(clip: Pick<ClipRecord, 'blob' | 'durationMs'>): number {
  const durationSec = Math.max(0.2, clip.durationMs / 1000)
  return (clip.blob.size * 8) / durationSec
}

/**
 * Next smaller encode for an existing clip, or null when the file is
 * already as small as Saver (or a photo). Never plans a larger bitrate
 * than the clip already uses.
 */
export function planClipQualityReduction(
  clip: Pick<ClipRecord, 'blob' | 'durationMs' | 'width' | 'height' | 'kind'>,
): ClipQualityReduction | null {
  if (isImageClip(clip)) return null
  const width = clip.width ?? 0
  const height = clip.height ?? 0
  if (!(width > 0) || !(height > 0)) return null

  const currentBps = estimatedClipBitsPerSecond(clip)
  const longEdge = Math.max(width, height)

  if (longEdge > STANDARD_LONG_EDGE) {
    const size = scaleToLongEdge(width, height, STANDARD_LONG_EDGE)
    const presetBps = videoBitrateFor(size.width, size.height, VIDEO_QUALITY_PRESETS.standard.captureBpp)
    const bitrate = Math.round(Math.min(presetBps, currentBps * SHRINK_RATIO))
    if (bitrate >= currentBps * ALREADY_SMALL_RATIO && size.width >= width && size.height >= height) {
      return null
    }
    return {
      summary: `${size.width}×${size.height} (720p)`,
      width: size.width,
      height: size.height,
      bitrate,
    }
  }

  const saverBps = videoBitrateFor(width, height, SAVER_BPP)
  if (currentBps <= saverBps * 1.15) return null
  const bitrate = Math.round(Math.min(saverBps, currentBps * SHRINK_RATIO))
  if (bitrate >= currentBps * ALREADY_SMALL_RATIO) return null
  return {
    summary: 'the same size at a smaller bitrate',
    width: even(width),
    height: even(height),
    bitrate,
  }
}
