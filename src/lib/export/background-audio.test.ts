import { describe, expect, it } from 'vitest'
import {
  EDGE_RAMP_MS,
  FADE_IN_MS,
  FADE_OUT_MS,
  VOLUME_RAMP_MS,
  createBackgroundMixer,
  gainAtMs,
  planBackgroundGain,
  type SequentialBackgroundSource,
} from './background-audio'

function segment(offsetMs: number, durationMs: number, audioVolume?: number) {
  return {
    offsetMs,
    startMs: 0,
    endMs: durationMs,
    clip: { audioVolume },
  }
}

const bothFades = { fadeIn: true, fadeOut: true }

describe('planBackgroundGain', () => {
  it('returns an empty envelope for empty plans', () => {
    expect(planBackgroundGain([], 0.25, 0, bothFades)).toEqual([])
    expect(planBackgroundGain([segment(0, 1000)], 0.25, 0, bothFades)).toEqual([])
  })

  it('fades in from silence and out to silence when enabled', () => {
    const points = planBackgroundGain([segment(0, 8000)], 0.25, 8000, bothFades)
    expect(gainAtMs(points, 0)).toBe(0)
    expect(gainAtMs(points, FADE_IN_MS / 2)).toBeCloseTo(0.125)
    expect(gainAtMs(points, FADE_IN_MS)).toBeCloseTo(0.25)
    expect(gainAtMs(points, 4000)).toBeCloseTo(0.25)
    expect(gainAtMs(points, 8000 - FADE_OUT_MS)).toBeCloseTo(0.25)
    expect(gainAtMs(points, 8000)).toBe(0)
  })

  it('keeps only inaudible click-kill edges when fades are disabled', () => {
    const points = planBackgroundGain([segment(0, 8000)], 0.25, 8000, {
      fadeIn: false,
      fadeOut: false,
    })
    expect(gainAtMs(points, EDGE_RAMP_MS)).toBeCloseTo(0.25)
    expect(gainAtMs(points, 8000 - EDGE_RAMP_MS)).toBeCloseTo(0.25)
    expect(gainAtMs(points, 8000)).toBe(0)
    // Well before what a real fade would cover, the gain is already full.
    expect(gainAtMs(points, 100)).toBeCloseTo(0.25)
    expect(gainAtMs(points, 7900)).toBeCloseTo(0.25)
  })

  it('honors the toggles independently', () => {
    const inOnly = planBackgroundGain([segment(0, 8000)], 0.5, 8000, {
      fadeIn: true,
      fadeOut: false,
    })
    expect(gainAtMs(inOnly, FADE_IN_MS / 2)).toBeCloseTo(0.25)
    expect(gainAtMs(inOnly, 7900)).toBeCloseTo(0.5)

    const outOnly = planBackgroundGain([segment(0, 8000)], 0.5, 8000, {
      fadeIn: false,
      fadeOut: true,
    })
    expect(gainAtMs(outOnly, 100)).toBeCloseTo(0.5)
    expect(gainAtMs(outOnly, 8000 - FADE_OUT_MS / 2)).toBeCloseTo(0.25)
  })

  it('ramps across a boundary between different clip volumes', () => {
    const points = planBackgroundGain(
      [segment(0, 4000, 0.8), segment(4000, 4000, 0.2)],
      0.25,
      8000,
      bothFades,
    )
    const half = VOLUME_RAMP_MS / 2
    expect(gainAtMs(points, 4000 - half)).toBeCloseTo(0.8)
    expect(gainAtMs(points, 4000)).toBeCloseTo(0.5)
    expect(gainAtMs(points, 4000 + half)).toBeCloseTo(0.2)
    expect(gainAtMs(points, 2000)).toBeCloseTo(0.8)
    expect(gainAtMs(points, 6000)).toBeCloseTo(0.2)
  })

  it('holds one flat gain across same-volume boundaries (no dip)', () => {
    const points = planBackgroundGain(
      [segment(0, 3000, 0.5), segment(3000, 3000, 0.5)],
      0.25,
      6000,
      bothFades,
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
      bothFades,
    )
    expect(gainAtMs(points, 2000)).toBeCloseTo(0.3)
    expect(gainAtMs(points, 6000)).toBe(0)
  })

  it('keeps time monotonic when clips are shorter than the ramps', () => {
    const points = planBackgroundGain(
      [segment(0, 120, 1), segment(120, 100, 0), segment(220, 130, 0.9)],
      0.25,
      350,
      bothFades,
    )
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i].tMs).toBeGreaterThanOrEqual(points[i - 1].tMs)
    }
    for (let t = 0; t <= 350; t += 10) {
      const gain = gainAtMs(points, t)
      expect(gain).toBeGreaterThanOrEqual(0)
      expect(gain).toBeLessThanOrEqual(1)
    }
  })
})

describe('createBackgroundMixer', () => {
  const flatEnvelope = [
    { tMs: 0, volume: 0.5 },
    { tMs: 1_000_000, volume: 0.5 },
  ]

  function sourceOf(tracks: Array<Float32Array[] | null>): SequentialBackgroundSource {
    return {
      trackCount: tracks.length,
      getTrack: (index) => Promise.resolve(tracks[index] ?? null),
    }
  }

  it('adds a track at the envelope gain', async () => {
    const slice = [new Float32Array([0.1, 0.1, 0.1, 0.1])]
    const mixer = createBackgroundMixer(
      sourceOf([[new Float32Array([0.4, 0.4, 0.4, 0.4])]]),
      flatEnvelope,
      48000,
    )
    await mixer.mixInto(slice, 0)
    for (const sample of slice[0]) {
      expect(sample).toBeCloseTo(0.1 + 0.4 * 0.5)
    }
  })

  it('plays tracks one after the other and goes silent when they run out', async () => {
    // Track A: two frames of 0.2; track B: two frames of 0.6; film: 6 frames.
    const mixer = createBackgroundMixer(
      sourceOf([[new Float32Array([0.2, 0.2])], [new Float32Array([0.6, 0.6])]]),
      [
        { tMs: 0, volume: 1 },
        { tMs: 1_000_000, volume: 1 },
      ],
      48000,
    )
    const slice = [new Float32Array(6)]
    await mixer.mixInto(slice, 0)
    expect(Array.from(slice[0]).map((v) => Number(v.toFixed(2)))).toEqual([
      0.2, 0.2, 0.6, 0.6, 0, 0,
    ])
  })

  it('mixes across slice boundaries in output order', async () => {
    const mixer = createBackgroundMixer(
      sourceOf([[new Float32Array([0.2, 0.2, 0.2])], [new Float32Array([0.6, 0.6, 0.6])]]),
      [
        { tMs: 0, volume: 1 },
        { tMs: 1_000_000, volume: 1 },
      ],
      48000,
    )
    const first = [new Float32Array(2)]
    const second = [new Float32Array(4)]
    await mixer.mixInto(first, 0)
    await mixer.mixInto(second, 2)
    expect(Array.from(first[0]).map((v) => Number(v.toFixed(2)))).toEqual([0.2, 0.2])
    // Second slice spans the A→B hand-off (frame 3) and B's end (frame 6).
    expect(Array.from(second[0]).map((v) => Number(v.toFixed(2)))).toEqual([0.2, 0.6, 0.6, 0.6])
  })

  it('skips undecodable tracks and continues with the next', async () => {
    const mixer = createBackgroundMixer(
      sourceOf([null, [new Float32Array([0.4, 0.4])]]),
      flatEnvelope,
      48000,
    )
    const slice = [new Float32Array(3)]
    await mixer.mixInto(slice, 0)
    expect(Array.from(slice[0]).map((v) => Number(v.toFixed(2)))).toEqual([0.2, 0.2, 0])
  })

  it('spreads a mono track across stereo slices and clamps the sum', async () => {
    const slice = [new Float32Array([0.9]), new Float32Array([-0.9])]
    const mixer = createBackgroundMixer(
      sourceOf([[new Float32Array([1])]]),
      [
        { tMs: 0, volume: 1 },
        { tMs: 1000, volume: 1 },
      ],
      48000,
    )
    await mixer.mixInto(slice, 0)
    expect(slice[0][0]).toBe(1)
    expect(slice[1][0]).toBeCloseTo(0.1)
  })

  it('leaves slices untouched when the gain is zero', async () => {
    const slice = [new Float32Array([0.3, 0.3])]
    const before = Array.from(slice[0])
    const mixer = createBackgroundMixer(
      sourceOf([[new Float32Array([0.5, 0.5])]]),
      [
        { tMs: 0, volume: 0 },
        { tMs: 1000, volume: 0 },
      ],
      48000,
    )
    await mixer.mixInto(slice, 0)
    expect(Array.from(slice[0])).toEqual(before)
  })

  it('decodes each track at most once (lazy, in order)', async () => {
    const decoded: number[] = []
    const mixer = createBackgroundMixer(
      {
        trackCount: 3,
        getTrack: (index) => {
          decoded.push(index)
          return Promise.resolve([new Float32Array(2).fill(0.1)])
        },
      },
      flatEnvelope,
      48000,
    )
    // The film only reaches into track 2's range (frames 0..5).
    await mixer.mixInto([new Float32Array(3)], 0)
    expect(decoded).toEqual([0, 1])
    await mixer.mixInto([new Float32Array(3)], 3)
    expect(decoded).toEqual([0, 1, 2])
  })
})
