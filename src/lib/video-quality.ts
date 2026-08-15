/** Capture request and export long-edge cap: 1080p, never 4K. */
export const VIDEO_LONG_EDGE = 1920
export const VIDEO_SHORT_EDGE = 1080
export const VIDEO_FPS = 30

/** Bits-per-pixel at 30fps. Capture is slightly richer than export so the
 * recorded file is not the weaker generation. */
export const CAPTURE_BPP = 0.16
export const EXPORT_BPP = 0.16

const BITRATE_MIN = 1_500_000
const BITRATE_MAX = 12_000_000

/** Hardware-AVC bitrate for a frame size: scales with pixels, floored so
 * tiny test/photo outputs stay cheap, capped so 1080p stays in the
 * 8–12 Mbps band instead of a flat 3.5 Mbps. */
export function videoBitrateFor(
  width: number,
  height: number,
  bitsPerPixel: number = EXPORT_BPP,
): number {
  const w = width > 0 ? width : VIDEO_LONG_EDGE
  const h = height > 0 ? height : VIDEO_SHORT_EDGE
  return Math.round(
    Math.min(BITRATE_MAX, Math.max(BITRATE_MIN, w * h * VIDEO_FPS * bitsPerPixel)),
  )
}

export function recordingVideoBitsPerSecond(width?: number, height?: number): number {
  return videoBitrateFor(width ?? VIDEO_LONG_EDGE, height ?? VIDEO_SHORT_EDGE, CAPTURE_BPP)
}
