import { describe, expect, it } from 'vitest'
import {
  EDGE_RAMP_MS,
  FADE_IN_MS,
  FADE_OUT_MS,
  VOLUME_RAMP_MS,
  boundaryRampHalfMs,
  createBackgroundMixer,
  gainAtMs,
  planSegmentGain,
  segmentVolume,
  type GainPoint,
  type SequentialBackgroundSource,
} from './background-audio'

const bothFades = { fadeIn: true, fadeOut: true }

describe('planSegmentGain', () => {
  it('returns an empty envelope for degenerate durations', () => {
    expect(planSegmentGain({ volume: 0.5, durationMs: 0, fades: bothFades })).toEqual([])
  })

  it('fades a single-segment film in from silence and out to silence', () => {
    const points = planSegmentGain({ volume: 0.25, durationMs: 8000, fades: bothFades })
    expect(gainAtMs(points, 0)).toBe(0)
    expect(gainAtMs(points, FADE_IN_MS / 2)).toBeCloseTo(0.125)
    expect(gainAtMs(points, FADE_IN_MS)).toBeCloseTo(0.25)
    expect(gainAtMs(points, 4000)).toBeCloseTo(0.25)
    expect(gainAtMs(points, 8000 - FADE_OUT_MS)).toBeCloseTo(0.25)
    expect(gainAtMs(points, 8000)).toBe(0)
  })

  it('keeps only inaudible click-kill edges when fades are disabled', () => {
    const points = planSegmentGain({
      volume: 0.25,
      durationMs: 8000,
      fades: { fadeIn: false, fadeOut: false },
    })
    expect(gainAtMs(points, EDGE_RAMP_MS)).toBeCloseTo(0.25)
    expect(gainAtMs(points, 100)).toBeCloseTo(0.25)
    expect(gainAtMs(points, 7900)).toBeCloseTo(0.25)
    expect(gainAtMs(points, 8000)).toBe(0)
  })

  it('honors the fade toggles independently', () => {
    const inOnly = planSegmentGain({
      volume: 0.5,
      durationMs: 8000,
      fades: { fadeIn: true, fadeOut: false },
    })
    expect(gainAtMs(inOnly, FADE_IN_MS / 2)).toBeCloseTo(0.25)
    expect(gainAtMs(inOnly, 7900)).toBeCloseTo(0.5)

    const outOnly = planSegmentGain({
      volume: 0.5,
      durationMs: 8000,
      fades: { fadeIn: false, fadeOut: true },
    })
    expect(gainAtMs(outOnly, 100)).toBeCloseTo(0.5)
    expect(gainAtMs(outOnly, 8000 - FADE_OUT_MS / 2)).toBeCloseTo(0.25)
  })

  it('ramps across a boundary between different clip volumes', () => {
    const half = VOLUME_RAMP_MS / 2
    // Two 4s clips at 0.8 → 0.2: the outgoing tail meets the incoming head
    // at the midpoint (0.5) exactly at the boundary.
    const outgoing = planSegmentGain({
      volume: 0.8,
      durationMs: 4000,
      exit: { toVolume: 0.2, halfMs: boundaryRampHalfMs(4000, 4000) },
      fades: bothFades,
    })
    expect(gainAtMs(outgoing, 2000)).toBeCloseTo(0.8)
    expect(gainAtMs(outgoing, 4000 - half)).toBeCloseTo(0.8)
    expect(gainAtMs(outgoing, 4000)).toBeCloseTo(0.5)

    const incoming = planSegmentGain({
      volume: 0.2,
      durationMs: 4000,
      entry: { fromVolume: 0.8, halfMs: boundaryRampHalfMs(4000, 4000) },
      fades: bothFades,
    })
    expect(gainAtMs(incoming, 0)).toBeCloseTo(0.5)
    expect(gainAtMs(incoming, half)).toBeCloseTo(0.2)
    expect(gainAtMs(incoming, 2000)).toBeCloseTo(0.2)
  })

  it('holds one flat gain across same-volume boundaries (no dip)', () => {
    const half = boundaryRampHalfMs(3000, 3000)
    const outgoing = planSegmentGain({
      volume: 0.5,
      durationMs: 3000,
      exit: { toVolume: 0.5, halfMs: half },
      fades: bothFades,
    })
    const incoming = planSegmentGain({
      volume: 0.5,
      durationMs: 3000,
      entry: { fromVolume: 0.5, halfMs: half },
      fades: bothFades,
    })
    expect(gainAtMs(outgoing, 2900)).toBeCloseTo(0.5)
    expect(gainAtMs(outgoing, 3000)).toBeCloseTo(0.5)
    expect(gainAtMs(incoming, 0)).toBeCloseTo(0.5)
    expect(gainAtMs(incoming, 100)).toBeCloseTo(0.5)
  })

  it('keeps time monotonic and gains in range on tiny segments', () => {
    const points = planSegmentGain({
      volume: 1,
      durationMs: 120,
      entry: { fromVolume: 0, halfMs: boundaryRampHalfMs(100, 120) },
      exit: { toVolume: 0.9, halfMs: boundaryRampHalfMs(120, 130) },
      fades: bothFades,
    })
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i].tMs).toBeGreaterThanOrEqual(points[i - 1].tMs)
    }
    for (let t = 0; t <= 120; t += 5) {
      const gain = gainAtMs(points, t)
      expect(gain).toBeGreaterThanOrEqual(0)
      expect(gain).toBeLessThanOrEqual(1)
    }
  })

  it('clamps the boundary ramp to the shorter neighbor', () => {
    expect(boundaryRampHalfMs(4000, 4000)).toBe(VOLUME_RAMP_MS / 2)
    expect(boundaryRampHalfMs(400, 4000)).toBe(200)
    expect(boundaryRampHalfMs(4000, 100)).toBe(50)
  })

  it('reads the clip override through segmentVolume', () => {
    expect(segmentVolume({ clip: { audioVolume: 0.7 } } as never, 0.25)).toBe(0.7)
    expect(segmentVolume({ clip: {} } as never, 0.25)).toBe(0.25)
  })
})

describe('createBackgroundMixer', () => {
  const flatEnvelope = (volume: number): GainPoint[] => [
    { tMs: 0, volume },
    { tMs: 1_000_000, volume },
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
      48000,
    )
    await mixer.mixInto(slice, 0, flatEnvelope(0.5))
    for (const sample of slice[0]) {
      expect(sample).toBeCloseTo(0.1 + 0.4 * 0.5)
    }
  })

  it('plays tracks one after the other and goes silent when they run out', async () => {
    // Track A: two frames of 0.2; track B: two frames of 0.6; film: 6 frames.
    const mixer = createBackgroundMixer(
      sourceOf([[new Float32Array([0.2, 0.2])], [new Float32Array([0.6, 0.6])]]),
      48000,
    )
    const slice = [new Float32Array(6)]
    await mixer.mixInto(slice, 0, flatEnvelope(1))
    expect(Array.from(slice[0]).map((v) => Number(v.toFixed(2)))).toEqual([
      0.2, 0.2, 0.6, 0.6, 0, 0,
    ])
  })

  it('mixes across slice boundaries in output order', async () => {
    const mixer = createBackgroundMixer(
      sourceOf([[new Float32Array([0.2, 0.2, 0.2])], [new Float32Array([0.6, 0.6, 0.6])]]),
      48000,
    )
    const first = [new Float32Array(2)]
    const second = [new Float32Array(4)]
    await mixer.mixInto(first, 0, flatEnvelope(1))
    await mixer.mixInto(second, 2, flatEnvelope(1))
    expect(Array.from(first[0]).map((v) => Number(v.toFixed(2)))).toEqual([0.2, 0.2])
    // Second slice spans the A→B hand-off (frame 3) and B's end (frame 6).
    expect(Array.from(second[0]).map((v) => Number(v.toFixed(2)))).toEqual([0.2, 0.6, 0.6, 0.6])
  })

  it('applies each slice its own local envelope', async () => {
    // One 4-frame track mixed as two slices with different gains — the
    // envelope is local to each slice (its time 0 = the slice start).
    const mixer = createBackgroundMixer(
      sourceOf([[new Float32Array([0.4, 0.4, 0.4, 0.4])]]),
      1000, // 1 frame = 1ms for readable positions
    )
    const first = [new Float32Array(2)]
    const second = [new Float32Array(2)]
    await mixer.mixInto(first, 0, flatEnvelope(1))
    await mixer.mixInto(second, 2, [
      { tMs: 0, volume: 0.5 },
      { tMs: 2, volume: 0.5 },
    ])
    expect(first[0][0]).toBeCloseTo(0.4)
    expect(second[0][0]).toBeCloseTo(0.2)
  })

  it('skips undecodable tracks and continues with the next', async () => {
    const mixer = createBackgroundMixer(
      sourceOf([null, [new Float32Array([0.4, 0.4])]]),
      48000,
    )
    const slice = [new Float32Array(3)]
    await mixer.mixInto(slice, 0, flatEnvelope(0.5))
    expect(Array.from(slice[0]).map((v) => Number(v.toFixed(2)))).toEqual([0.2, 0.2, 0])
  })

  it('spreads a mono track across stereo slices and clamps the sum', async () => {
    const slice = [new Float32Array([0.9]), new Float32Array([-0.9])]
    const mixer = createBackgroundMixer(sourceOf([[new Float32Array([1])]]), 48000)
    await mixer.mixInto(slice, 0, flatEnvelope(1))
    expect(slice[0][0]).toBe(1)
    expect(slice[1][0]).toBeCloseTo(0.1)
  })

  it('leaves slices untouched when the gain is zero', async () => {
    const slice = [new Float32Array([0.3, 0.3])]
    const before = Array.from(slice[0])
    const mixer = createBackgroundMixer(sourceOf([[new Float32Array([0.5, 0.5])]]), 48000)
    await mixer.mixInto(slice, 0, flatEnvelope(0))
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
      48000,
    )
    // The film only reaches into track 2's range (frames 0..5).
    await mixer.mixInto([new Float32Array(3)], 0, flatEnvelope(0.5))
    expect(decoded).toEqual([0, 1])
    await mixer.mixInto([new Float32Array(3)], 3, flatEnvelope(0.5))
    expect(decoded).toEqual([0, 1, 2])
  })
})
