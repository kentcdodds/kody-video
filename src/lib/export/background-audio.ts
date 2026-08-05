import { clipAudioVolume } from '../types'
import type { PlannedSegment } from './plan'

/**
 * Background-music mix planning shared by both export engines and unit
 * tests. The per-clip value is the music's SHARE of the audio mix: gain g
 * for the music means gain (1 − g) for the clip's own sound, so the two
 * always sum to one — no clipping, no shouting match between mic and
 * music. Per-clip shares become piecewise-linear envelopes (mix changes
 * glide across clip boundaries), and the playlist's tracks are mixed in
 * one after the other — the film's end cuts the music off, nothing loops.
 */

/** Length of the glide between two clips with different music shares. */
export const VOLUME_RAMP_MS = 600
/** Musical ease-in at the start of the film (the "Fade in" toggle). */
export const FADE_IN_MS = 800
/** Musical ease-out at the end of the film (the "Fade out" toggle). */
export const FADE_OUT_MS = 1200
/** With fades off, a click-kill ramp too short to hear as a fade. */
export const EDGE_RAMP_MS = 15
/** When the playlist runs out mid-film, the clip sound eases back to full
 * volume over this window instead of jumping. */
export const PLAYLIST_END_RAMP_MS = 300

/** Peak both sources are normalized toward before blending. */
export const NORMALIZED_PEAK = 0.9
/** Never boost quiet audio more than this (+12 dB) — it amplifies noise. */
export const MAX_NORMALIZATION_BOOST = 4
/** Below this peak the audio is treated as silence and never boosted. */
export const NORMALIZATION_SILENCE_FLOOR = 0.01

/** Exact peak of decoded channel data. Every sample is scanned: a strided
 * scan can miss a transient, and a boost derived from an undermeasured
 * peak would push that transient into the hard clamp instead of keeping
 * the intended headroom. One pass over even a long song is milliseconds. */
export function channelPeak(channels: Float32Array[]): number {
  let peak = 0
  for (const data of channels) {
    for (let i = 0; i < data.length; i += 1) {
      const value = Math.abs(data[i])
      if (value > peak) peak = value
    }
  }
  return peak
}

/** Gain that brings a source's peak toward NORMALIZED_PEAK, bounded so
 * near-silence is never blown up into noise. */
export function normalizationScale(peak: number): number {
  if (!Number.isFinite(peak) || peak < NORMALIZATION_SILENCE_FLOOR) return 1
  return Math.min(MAX_NORMALIZATION_BOOST, NORMALIZED_PEAK / peak)
}

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

export interface BackgroundFades {
  fadeIn: boolean
  fadeOut: boolean
}

export interface SegmentGainArgs {
  /** This clip's music volume. */
  volume: number
  /** The segment's REAL duration (after media clamping), in ms. */
  durationMs: number
  /** Ramp in from the previous clip's volume (omit at the film start). */
  entry?: { fromVolume: number; halfMs: number }
  /** Ramp out toward the next clip's volume (omit at the film end). */
  exit?: { toVolume: number; halfMs: number }
  fades: BackgroundFades
}

/**
 * Piecewise-linear gain envelope for ONE segment, on the segment's local
 * timeline (0..durationMs). Built per segment from real clamped durations —
 * planning the whole film's envelope up front drifted whenever media
 * clamping shortened a clip. Boundary ramps are centered on the clip
 * transition: the outgoing segment carries the first half (volume → the
 * two clips' midpoint), the incoming segment carries the second (midpoint →
 * its volume). Disabled film-edge fades still get an inaudible edge ramp —
 * a hard cut mid-waveform clicks.
 */
export function planSegmentGain({
  volume,
  durationMs,
  entry,
  exit,
  fades,
}: SegmentGainArgs): GainPoint[] {
  if (durationMs <= 0) return []
  const points: GainPoint[] = []
  if (entry) {
    points.push({ tMs: 0, volume: (entry.fromVolume + volume) / 2 })
    points.push({ tMs: Math.min(entry.halfMs, durationMs / 2), volume })
  } else {
    const fadeIn = Math.min(fades.fadeIn ? FADE_IN_MS : EDGE_RAMP_MS, durationMs / 2)
    points.push({ tMs: 0, volume: 0 })
    points.push({ tMs: fadeIn, volume })
  }
  if (exit) {
    points.push({ tMs: durationMs - Math.min(exit.halfMs, durationMs / 2), volume })
    points.push({ tMs: durationMs, volume: (volume + exit.toVolume) / 2 })
  } else {
    const fadeOut = Math.min(fades.fadeOut ? FADE_OUT_MS : EDGE_RAMP_MS, durationMs / 2)
    points.push({ tMs: durationMs - fadeOut, volume })
    points.push({ tMs: durationMs, volume: 0 })
  }
  // Overlapping ramps (very short clips) collapse into steps instead of
  // travelling back in time.
  for (let i = 1; i < points.length; i += 1) {
    points[i].tMs = Math.max(points[i].tMs, points[i - 1].tMs)
  }
  return points
}

/** Centered boundary-ramp half length, clamped to the shorter neighbor. */
export function boundaryRampHalfMs(aDurationMs: number, bDurationMs: number): number {
  return Math.min(VOLUME_RAMP_MS / 2, aDurationMs / 2, bDurationMs / 2)
}

/** Music volume for one planned segment (override or default). */
export function segmentVolume(
  segment: Pick<PlannedSegment, 'clip'>,
  defaultVolume: number,
): number {
  return clipAudioVolume(segment.clip, defaultVolume)
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
  /** Blend the playlist into a segment slice's channels (which carry the
   * clip's own sound), in place: `out = clip·fgScale·(1−g) + music·g`,
   * where g follows `points` — the slice's own local envelope (its time 0
   * is the slice's first sample) — and `foregroundScale` is the clip's
   * normalization gain. Slices must be requested in output order (tracks
   * are decoded lazily, one at a time, and released once the timeline
   * passes them). */
  mixInto: (
    channels: Float32Array[],
    sliceStartFrame: number,
    points: GainPoint[],
    foregroundScale?: number,
  ) => Promise<void>
}

/**
 * Sequential playlist mixer: track 0 starts at output frame 0, each next
 * track starts where the previous one's decoded samples end, and when the
 * playlist runs out the clip sound eases back to full volume (over
 * PLAYLIST_END_RAMP_MS) and the rest of the film simply has no music.
 * Everything hard-clamps to [-1, 1].
 */
export function createBackgroundMixer(
  source: SequentialBackgroundSource,
  sampleRate: number,
): BackgroundMixer {
  let trackIndex = -1
  /** Output frame where the current track begins. */
  let trackStartFrame = 0
  let current: Float32Array[] | null = null
  let exhausted = source.trackCount === 0
  /** Frame where the playlist ran out, and the music share right before —
   * the foreground ramps from (1 − that share) back to full from here. */
  let exhaustedAtFrame: number | null = null
  let shareAtExhaustion = 0

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

  const clamp = (value: number): number => (value > 1 ? 1 : value < -1 ? -1 : value)

  const mixInto = async (
    channels: Float32Array[],
    sliceStartFrame: number,
    points: GainPoint[],
    foregroundScale = 1,
  ): Promise<void> => {
    if (channels.length === 0 || points.length === 0) return
    const sliceLength = channels[0].length
    const endRampFrames = Math.max(1, Math.round((PLAYLIST_END_RAMP_MS / 1000) * sampleRate))
    let i = 0
    let cursor = 0
    while (i < sliceLength) {
      const frame = sliceStartFrame + i
      if (!(await ensureTrackFor(frame))) {
        // Playlist over: no music, but the clip keeps its normalization
        // (consistent loudness across the whole film) and its share eases
        // from (1 − last music share) back to full instead of jumping.
        exhaustedAtFrame ??= frame
        for (; i < sliceLength; i += 1) {
          const outFrame = sliceStartFrame + i
          const ramp = Math.min(1, (outFrame - exhaustedAtFrame) / endRampFrames)
          const foreground =
            foregroundScale * (1 - shareAtExhaustion + shareAtExhaustion * ramp)
          for (let ch = 0; ch < channels.length; ch += 1) {
            channels[ch][i] = clamp(channels[ch][i] * foreground)
          }
        }
        return
      }
      const track = current!
      const sources = channels.map((_, ch) => track[Math.min(ch, track.length - 1)])
      // Mix until the slice or the current track ends, whichever is first.
      const runEnd = Math.min(sliceLength, trackStartFrame + track[0].length - sliceStartFrame)
      for (; i < runEnd; i += 1) {
        const outFrame = sliceStartFrame + i
        const tMs = (i / sampleRate) * 1000
        while (cursor < points.length && points[cursor].tMs < tMs) cursor += 1
        let share: number
        if (cursor === 0) {
          share = points[0].volume
        } else if (cursor >= points.length) {
          share = points[points.length - 1].volume
        } else {
          const prev = points[cursor - 1]
          const next = points[cursor]
          const span = next.tMs - prev.tMs
          share =
            span <= 0
              ? next.volume
              : prev.volume + ((next.volume - prev.volume) * (tMs - prev.tMs)) / span
        }
        shareAtExhaustion = share
        const sourceIndex = outFrame - trackStartFrame
        for (let ch = 0; ch < channels.length; ch += 1) {
          channels[ch][i] = clamp(
            channels[ch][i] * foregroundScale * (1 - share) + sources[ch][sourceIndex] * share,
          )
        }
      }
    }
  }

  return { mixInto }
}
