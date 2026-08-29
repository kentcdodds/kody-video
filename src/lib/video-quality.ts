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

/** New recordings only. Always 30fps — quality only changes size and bitrate. */
export type VideoQualityPreset = 'high' | 'standard' | 'saver'

export const VIDEO_QUALITY_PRESETS: Record<
  VideoQualityPreset,
  {
    id: VideoQualityPreset
    label: string
    /** One-line hint for the selected option. */
    hint: string
    longEdge: number
    shortEdge: number
    captureBpp: number
  }
> = {
  high: {
    id: 'high',
    label: 'High',
    hint: '1080p — Plus. Sharpest new clips, largest files.',
    longEdge: VIDEO_LONG_EDGE,
    shortEdge: VIDEO_SHORT_EDGE,
    captureBpp: CAPTURE_BPP,
  },
  standard: {
    id: 'standard',
    label: 'Standard',
    hint: '720p — about half the space of High, still 30 fps.',
    longEdge: 1280,
    shortEdge: 720,
    captureBpp: CAPTURE_BPP,
  },
  saver: {
    id: 'saver',
    label: 'Saver',
    hint: '720p at a smaller bitrate — smallest files, still 30 fps.',
    longEdge: 1280,
    shortEdge: 720,
    captureBpp: 0.08,
  },
}

export const VIDEO_QUALITY_IDS = ['high', 'standard', 'saver'] as const satisfies readonly VideoQualityPreset[]

/** Free (and unknown-plus) default — 720p, still 30fps. */
export const FREE_VIDEO_QUALITY: VideoQualityPreset = 'standard'
/** Plus default when the user has not picked a preset — 1080p is the perk. */
export const PLUS_DEFAULT_VIDEO_QUALITY: VideoQualityPreset = 'high'

let activeQuality: VideoQualityPreset = FREE_VIDEO_QUALITY

export function resolveVideoQuality(value: unknown, plus = false): VideoQualityPreset {
  if (value === 'standard' || value === 'saver') return value
  if (value === 'high') return plus ? 'high' : FREE_VIDEO_QUALITY
  return plus ? PLUS_DEFAULT_VIDEO_QUALITY : FREE_VIDEO_QUALITY
}

/** In-memory capture preset used by the camera and recorder (sync). Hydrated
 * from settings on load so the first take already matches the user's choice. */
export function setActiveVideoQuality(value: unknown, plus = false): VideoQualityPreset {
  activeQuality = resolveVideoQuality(value, plus)
  return activeQuality
}

export function activeVideoQuality(): VideoQualityPreset {
  return activeQuality
}

export function resetActiveVideoQualityForTests(): void {
  activeQuality = FREE_VIDEO_QUALITY
}

export function videoQualityPreset(
  quality: VideoQualityPreset = activeQuality,
): (typeof VIDEO_QUALITY_PRESETS)[VideoQualityPreset] {
  return VIDEO_QUALITY_PRESETS[quality]
}

/** getUserMedia hint for the active (or given) quality. Frame rate stays 30. */
export function captureVideoConstraints(
  quality: VideoQualityPreset = activeQuality,
): MediaTrackConstraints {
  const preset = VIDEO_QUALITY_PRESETS[quality]
  return {
    width: { ideal: preset.longEdge },
    height: { ideal: preset.shortEdge },
    frameRate: { ideal: VIDEO_FPS },
  }
}

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

export function recordingVideoBitsPerSecond(
  width?: number,
  height?: number,
  quality: VideoQualityPreset = activeQuality,
): number {
  const preset = VIDEO_QUALITY_PRESETS[quality]
  // Cameras often ignore `ideal` size and hand back a 1080p (or larger)
  // track. Bill at most the preset's frame so Standard/Saver still use
  // less bits than High — do not add mandatory `max` constraints, which
  // can fail getUserMedia or force a software scale.
  const trackLong = Math.max(width ?? 0, height ?? 0)
  const trackShort = Math.min(width ?? 0, height ?? 0)
  return videoBitrateFor(
    trackLong > 0 ? Math.min(trackLong, preset.longEdge) : preset.longEdge,
    trackShort > 0 ? Math.min(trackShort, preset.shortEdge) : preset.shortEdge,
    preset.captureBpp,
  )
}
