import { clipAudioVolume } from '../types'
import type { PlannedSegment } from './plan'

/**
 * Background-music gain planning shared by both export engines and unit
 * tests: turns the per-clip volumes into one piecewise-linear gain envelope
 * over the output timeline, so volume changes glide across clip boundaries
 * instead of jumping.
 */

/** Length of the glide between two clips with different music volumes. */
export const VOLUME_RAMP_MS = 600
/** Music eases in at the start of the film rather than slamming on. */
export const FADE_IN_MS = 300
/** …and eases out at the end rather than cutting mid-note. */
export const FADE_OUT_MS = 600

export interface BackgroundAudioTrack {
  blob: Blob
  defaultVolume: number
}

export interface GainPoint {
  tMs: number
  volume: number
}

type GainSegment = Pick<PlannedSegment, 'offsetMs'> & {
  clip: Pick<PlannedSegment['clip'], 'audioVolume'>
  startMs: number
  endMs: number
}

/**
 * Piecewise-linear gain envelope for the whole output timeline. Boundary
 * ramps are centered on each clip transition and clamped to the shorter
 * neighbor, so even sub-second clips keep a monotonic envelope.
 */
export function planBackgroundGain(
  segments: GainSegment[],
  defaultVolume: number,
  totalMs: number,
): GainPoint[] {
  if (segments.length === 0 || totalMs <= 0) return []
  const volumes = segments.map((segment) => clipAudioVolume(segment.clip, defaultVolume))
  const durations = segments.map((segment) => segment.endMs - segment.startMs)

  const points: GainPoint[] = [
    { tMs: 0, volume: 0 },
    { tMs: Math.min(FADE_IN_MS, durations[0] / 2), volume: volumes[0] },
  ]
  for (let i = 1; i < segments.length; i += 1) {
    if (volumes[i] === volumes[i - 1]) continue
    const boundary = segments[i].offsetMs
    const half = Math.min(VOLUME_RAMP_MS / 2, durations[i - 1] / 2, durations[i] / 2)
    points.push({ tMs: boundary - half, volume: volumes[i - 1] })
    points.push({ tMs: boundary + half, volume: volumes[i] })
  }
  const fadeOut = Math.min(FADE_OUT_MS, durations[durations.length - 1] / 2)
  points.push({ tMs: totalMs - fadeOut, volume: volumes[volumes.length - 1] })
  points.push({ tMs: totalMs, volume: 0 })

  // Overlapping ramps (very short clips) collapse into steps instead of
  // travelling back in time.
  for (let i = 1; i < points.length; i += 1) {
    points[i].tMs = Math.max(points[i].tMs, points[i - 1].tMs)
  }
  return points
}

/** Envelope gain at an output-timeline position (linear between points). */
export function gainAtMs(points: GainPoint[], tMs: number): number {
  if (points.length === 0) return 0
  if (tMs <= points[0].tMs) return points[0].volume
  for (let i = 1; i < points.length; i += 1) {
    if (tMs <= points[i].tMs) {
      const prev = points[i - 1]
      const next = points[i]
      const span = next.tMs - prev.tMs
      if (span <= 0) return next.volume
      return prev.volume + ((next.volume - prev.volume) * (tMs - prev.tMs)) / span
    }
  }
  return points[points.length - 1].volume
}

export interface MixBackgroundArgs {
  /** Slice channel data, mutated in place. All channels equal length. */
  channels: Float32Array[]
  /** Decoded background track at the same sample rate (any channel count). */
  background: Float32Array[]
  sampleRate: number
  /** Output-timeline frame index of the slice's first sample. */
  sliceStartFrame: number
  points: GainPoint[]
}

/**
 * Add the background track into a segment's audio slice, sample-accurately:
 * gain follows the envelope, the track loops when shorter than the film,
 * and the sum hard-clamps to [-1, 1].
 */
export function mixBackgroundIntoChannels({
  channels,
  background,
  sampleRate,
  sliceStartFrame,
  points,
}: MixBackgroundArgs): void {
  const backgroundLength = background[0]?.length ?? 0
  if (backgroundLength === 0 || channels.length === 0 || points.length === 0) return
  const sliceLength = channels[0].length
  const sources = channels.map(
    (_, ch) => background[Math.min(ch, background.length - 1)],
  )

  // Walking cursor into the envelope keeps per-sample gain O(1).
  let cursor = 0
  for (let i = 0; i < sliceLength; i += 1) {
    const frame = sliceStartFrame + i
    const tMs = (frame / sampleRate) * 1000
    while (cursor < points.length && points[cursor].tMs < tMs) cursor += 1
    let gain: number
    if (cursor === 0) {
      gain = points[0].volume
    } else if (cursor >= points.length) {
      gain = points[points.length - 1].volume
    } else {
      const prev = points[cursor - 1]
      const next = points[cursor]
      const span = next.tMs - prev.tMs
      gain =
        span <= 0
          ? next.volume
          : prev.volume + ((next.volume - prev.volume) * (tMs - prev.tMs)) / span
    }
    if (gain <= 0) continue
    const backgroundIndex = frame % backgroundLength
    for (let ch = 0; ch < channels.length; ch += 1) {
      const mixed = channels[ch][i] + sources[ch][backgroundIndex] * gain
      channels[ch][i] = mixed > 1 ? 1 : mixed < -1 ? -1 : mixed
    }
  }
}
