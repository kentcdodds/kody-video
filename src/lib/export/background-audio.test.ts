import { describe, expect, it } from 'vitest'
import {
  FADE_IN_MS,
  FADE_OUT_MS,
  VOLUME_RAMP_MS,
  gainAtMs,
  mixBackgroundIntoChannels,
  planBackgroundGain,
} from './background-audio'

function segment(offsetMs: number, durationMs: number, audioVolume?: number) {
  return {
    offsetMs,
    startMs: 0,
    endMs: durationMs,
    clip: { audioVolume },
  }
}

describe('planBackgroundGain', () => {
  it('returns an empty envelope for empty plans', () => {
    expect(planBackgroundGain([], 0.25, 0)).toEqual([])
    expect(planBackgroundGain([segment(0, 1000)], 0.25, 0)).toEqual([])
  })

  it('fades in from silence and out to silence', () => {
    const points = planBackgroundGain([segment(0, 5000)], 0.25, 5000)
    expect(gainAtMs(points, 0)).toBe(0)
    expect(gainAtMs(points, FADE_IN_MS)).toBeCloseTo(0.25)
    expect(gainAtMs(points, 2500)).toBeCloseTo(0.25)
    expect(gainAtMs(points, 5000 - FADE_OUT_MS)).toBeCloseTo(0.25)
    expect(gainAtMs(points, 5000)).toBe(0)
  })

  it('ramps across a boundary between different clip volumes', () => {
    const points = planBackgroundGain(
      [segment(0, 4000, 0.8), segment(4000, 4000, 0.2)],
      0.25,
      8000,
    )
    const half = VOLUME_RAMP_MS / 2
    expect(gainAtMs(points, 4000 - half)).toBeCloseTo(0.8)
    expect(gainAtMs(points, 4000)).toBeCloseTo(0.5)
    expect(gainAtMs(points, 4000 + half)).toBeCloseTo(0.2)
    // Steady state well away from the boundary.
    expect(gainAtMs(points, 2000)).toBeCloseTo(0.8)
    expect(gainAtMs(points, 6000)).toBeCloseTo(0.2)
  })

  it('holds one flat gain across same-volume boundaries (no dip)', () => {
    const points = planBackgroundGain(
      [segment(0, 3000, 0.5), segment(3000, 3000, 0.5)],
      0.25,
      6000,
    )
    expect(gainAtMs(points, 2900)).toBeCloseTo(0.5)
    expect(gainAtMs(points, 3000)).toBeCloseTo(0.5)
    expect(gainAtMs(points, 3100)).toBeCloseTo(0.5)
  })

  it('falls back to the default volume for clips without an override', () => {
    const points = planBackgroundGain(
      [segment(0, 4000), segment(4000, 4000, 0)],
      0.3,
      8000,
    )
    expect(gainAtMs(points, 2000)).toBeCloseTo(0.3)
    expect(gainAtMs(points, 6000)).toBe(0)
  })

  it('keeps time monotonic when clips are shorter than the ramps', () => {
    const points = planBackgroundGain(
      [segment(0, 120, 1), segment(120, 100, 0), segment(220, 130, 0.9)],
      0.25,
      350,
    )
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i].tMs).toBeGreaterThanOrEqual(points[i - 1].tMs)
    }
    // Every gain the envelope produces stays within the volume range.
    for (let t = 0; t <= 350; t += 10) {
      const gain = gainAtMs(points, t)
      expect(gain).toBeGreaterThanOrEqual(0)
      expect(gain).toBeLessThanOrEqual(1)
    }
  })
})

describe('mixBackgroundIntoChannels', () => {
  const flatEnvelope = [
    { tMs: 0, volume: 0.5 },
    { tMs: 1_000_000, volume: 0.5 },
  ]

  it('adds the background at the envelope gain', () => {
    const slice = [new Float32Array([0.1, 0.1, 0.1, 0.1])]
    const background = [new Float32Array([0.4, 0.4, 0.4, 0.4])]
    mixBackgroundIntoChannels({
      channels: slice,
      background,
      sampleRate: 48000,
      sliceStartFrame: 0,
      points: flatEnvelope,
    })
    for (const sample of slice[0]) {
      expect(sample).toBeCloseTo(0.1 + 0.4 * 0.5)
    }
  })

  it('loops the background when the film is longer than the track', () => {
    const slice = [new Float32Array(6)]
    const background = [new Float32Array([0.2, 0.4])]
    mixBackgroundIntoChannels({
      channels: slice,
      background,
      sampleRate: 48000,
      sliceStartFrame: 5,
      points: flatEnvelope,
    })
    // Frames 5..10 alternate through the 2-sample track: odd → 0.4, even → 0.2.
    expect(Array.from(slice[0]).map((v) => Number(v.toFixed(2)))).toEqual([
      0.2, 0.1, 0.2, 0.1, 0.2, 0.1,
    ])
  })

  it('spreads a mono background across stereo slices and clamps the sum', () => {
    const slice = [new Float32Array([0.9]), new Float32Array([-0.9])]
    const background = [new Float32Array([1])]
    mixBackgroundIntoChannels({
      channels: slice,
      background,
      sampleRate: 48000,
      sliceStartFrame: 0,
      points: [
        { tMs: 0, volume: 1 },
        { tMs: 1000, volume: 1 },
      ],
    })
    expect(slice[0][0]).toBe(1)
    expect(slice[1][0]).toBeCloseTo(0.1)
  })

  it('leaves the slice untouched when the gain is zero', () => {
    const slice = [new Float32Array([0.3, 0.3])]
    const before = Array.from(slice[0])
    mixBackgroundIntoChannels({
      channels: slice,
      background: [new Float32Array([0.5, 0.5])],
      sampleRate: 48000,
      sliceStartFrame: 0,
      points: [
        { tMs: 0, volume: 0 },
        { tMs: 1000, volume: 0 },
      ],
    })
    expect(Array.from(slice[0])).toEqual(before)
  })
})
