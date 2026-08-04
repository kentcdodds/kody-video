import { clipAudioVolume } from '../types'
import type { PlannedSegment } from './plan'

/**
 * Background-music gain planning and mixing shared by both export engines
 * and unit tests: per-clip volumes become one piecewise-linear gain envelope
 * over the output timeline (volume changes glide across clip boundaries),
 * and the playlist's tracks are mixed in one after the other — the film's
 * end cuts the music off, nothing loops.
 */

/** Length of the glide between two clips with different music volumes. */
export const VOLUME_RAMP_MS = 600
/** Musical ease-in at the start of the film (the "Fade in" toggle). */
export const FADE_IN_MS = 800
/** Musical ease-out at the end of the film (the "Fade out" toggle). */
export const FADE_OUT_MS = 1200
/** With fades off, a click-kill ramp too short to hear as a fade. */
export const EDGE_RAMP_MS = 15

export interface BackgroundAudio {
  tracks: Array<{ blob: Blob }>
  defaultVolume: number
  fadeIn: boolean
  fadeOut: boolean
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

export interface BackgroundFades {
  fadeIn: boolean
  fadeOut: boolean
}

/**
 * Piecewise-linear gain envelope for the whole output timeline. Boundary
 * ramps are centered on each clip transition and clamped to the shorter
 * neighbor, so even sub-second clips keep a monotonic envelope. Disabled
 * fades still get an inaudible edge ramp — a hard cut mid-waveform clicks.
 */
export function planBackgroundGain(
  segments: GainSegment[],
  defaultVolume: number,
  totalMs: number,
  fades: BackgroundFades,
): GainPoint[] {
  if (segments.length === 0 || totalMs <= 0) return []
  const volumes = segments.map((segment) => clipAudioVolume(segment.clip, defaultVolume))
  const durations = segments.map((segment) => segment.endMs - segment.startMs)

  const fadeIn = Math.min(fades.fadeIn ? FADE_IN_MS : EDGE_RAMP_MS, totalMs / 2)
  const fadeOut = Math.min(fades.fadeOut ? FADE_OUT_MS : EDGE_RAMP_MS, totalMs / 2)

  const points: GainPoint[] = [
    { tMs: 0, volume: 0 },
    { tMs: fadeIn, volume: volumes[0] },
  ]
  for (let i = 1; i < segments.length; i += 1) {
    if (volumes[i] === volumes[i - 1]) continue
    const boundary = segments[i].offsetMs
    const half = Math.min(VOLUME_RAMP_MS / 2, durations[i - 1] / 2, durations[i] / 2)
    points.push({ tMs: boundary - half, volume: volumes[i - 1] })
    points.push({ tMs: boundary + half, volume: volumes[i] })
  }
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

export interface SequentialBackgroundSource {
  trackCount: number
  /** Decode track `index` into per-channel data; null = undecodable (the
   * track is skipped and the next one starts in its place). */
  getTrack: (index: number) => Promise<Float32Array[] | null>
}

export interface BackgroundMixer {
  /** Add the playlist into a segment slice's channels, in place. Slices
   * must be requested in output order (tracks are decoded lazily, one at a
   * time, and released once the timeline passes them). `gainBaseMs` is the
   * slice's position on the envelope's (planned) timeline — passing the
   * planned segment offset keeps per-clip ramps and fades aligned with
   * their clips even when media clamping shifted the real frame positions;
   * it defaults to the frame-derived position. */
  mixInto: (
    channels: Float32Array[],
    sliceStartFrame: number,
    gainBaseMs?: number,
  ) => Promise<void>
}

/**
 * Sequential playlist mixer: track 0 starts at output frame 0, each next
 * track starts where the previous one's decoded samples end, and when the
 * playlist runs out the rest of the film simply has no music. Gain follows
 * the envelope; the sum hard-clamps to [-1, 1].
 */
export function createBackgroundMixer(
  source: SequentialBackgroundSource,
  points: GainPoint[],
  sampleRate: number,
): BackgroundMixer {
  let trackIndex = -1
  /** Output frame where the current track begins. */
  let trackStartFrame = 0
  let current: Float32Array[] | null = null
  let exhausted = source.trackCount === 0 || points.length === 0

  /** Advance until the current track covers `frame` (false = playlist over). */
  const ensureTrackFor = async (frame: number): Promise<boolean> => {
    for (;;) {
      if (exhausted) return false
      if (current && frame < trackStartFrame + current[0].length) return true
      if (current) {
        trackStartFrame += current[0].length
        current = null
      }
      trackIndex += 1
      if (trackIndex >= source.trackCount) {
        exhausted = true
        return false
      }
      const next = await source.getTrack(trackIndex)
      if (next && next.length > 0 && next[0].length > 0) {
        current = next
      }
    }
  }

  const mixInto = async (
    channels: Float32Array[],
    sliceStartFrame: number,
    gainBaseMs = (sliceStartFrame / sampleRate) * 1000,
  ): Promise<void> => {
    if (channels.length === 0) return
    const sliceLength = channels[0].length
    let i = 0
    let cursor = 0
    while (i < sliceLength) {
      const frame = sliceStartFrame + i
      if (!(await ensureTrackFor(frame))) return
      const track = current!
      const sources = channels.map((_, ch) => track[Math.min(ch, track.length - 1)])
      // Mix until the slice or the current track ends, whichever is first.
      const runEnd = Math.min(sliceLength, trackStartFrame + track[0].length - sliceStartFrame)
      for (; i < runEnd; i += 1) {
        const outFrame = sliceStartFrame + i
        const tMs = gainBaseMs + (i / sampleRate) * 1000
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
        const sourceIndex = outFrame - trackStartFrame
        for (let ch = 0; ch < channels.length; ch += 1) {
          const mixed = channels[ch][i] + sources[ch][sourceIndex] * gain
          channels[ch][i] = mixed > 1 ? 1 : mixed < -1 ? -1 : mixed
        }
      }
    }
  }

  return { mixInto }
}
