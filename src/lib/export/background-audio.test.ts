import { describe, expect, it } from 'vitest'
import {
  EDGE_RAMP_MS,
  FADE_IN_MS,
  FADE_OUT_MS,
  MAX_NORMALIZATION_BOOST,
  NORMALIZED_PEAK,
  VOLUME_RAMP_MS,
  boundaryRampHalfMs,
  channelPeak,
  createBackgroundMixer,
  filmEdgeFades,
  gainAtMs,
  normalizationScale,
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

describe('filmEdgeFades', () => {
  const blob = new Blob(['x'])
  const playlist = { defaultVolume: 0.25, fadeIn: true, fadeOut: true }

  it('reads the film edges from the tracks that play there', () => {
    const fades = filmEdgeFades(
      {
        ...playlist,
        tracks: [
          { blob, durationMs: 4_000, fadeIn: false },
          { blob, durationMs: 20_000, fadeOut: false },
        ],
      },
      6_000,
    )
    // The first track opens the film without a fade; the film's end lands
    // inside track 2, whose fade-out is off.
    expect(fades).toEqual({ fadeIn: false, fadeOut: false })
  })

  it('inherits playlist flags for tracks without their own', () => {
    expect(
      filmEdgeFades({ ...playlist, tracks: [{ blob, durationMs: 20_000 }] }, 6_000),
    ).toEqual({ fadeIn: true, fadeOut: true })
  })

  it('respects trimmed lengths when finding the film-end track', () => {
    const fades = filmEdgeFades(
      {
        ...playlist,
        tracks: [
          // Kept window 2s — the film's end at 5s lands in track 2.
          { blob, durationMs: 20_000, trimStartMs: 3_000, trimEndMs: 5_000 },
          { blob, durationMs: 20_000, fadeOut: false },
        ],
      },
      5_000,
    )
    expect(fades.fadeOut).toBe(false)
  })

  it('needs no film-end fade when the playlist runs out early', () => {
    expect(
      filmEdgeFades({ ...playlist, tracks: [{ blob, durationMs: 3_000 }] }, 10_000),
    ).toEqual({ fadeIn: true, fadeOut: false })
  })

  it('handles an empty playlist', () => {
    expect(filmEdgeFades({ ...playlist, tracks: [] }, 10_000)).toEqual({
      fadeIn: false,
      fadeOut: false,
    })
  })
})

describe('normalization', () => {
  it('measures the peak across channels', () => {
    expect(
      channelPeak([new Float32Array([0.1, -0.6]), new Float32Array([0.3, 0.2])]),
    ).toBeCloseTo(0.6)
    expect(channelPeak([new Float32Array(4)])).toBe(0)
  })

  it('never misses a lone transient (exact scan, no striding)', () => {
    // One full-scale spike buried in a long quiet buffer: a strided scan
    // would miss it, derive a big boost, and clip it against the clamp.
    const data = new Float32Array(100_000).fill(0.05)
    data[73_331] = -1
    expect(channelPeak([data])).toBe(1)
    expect(normalizationScale(channelPeak([data]))).toBeCloseTo(NORMALIZED_PEAK)
  })

  it('scales toward the target peak, bounded on both sides', () => {
    expect(normalizationScale(NORMALIZED_PEAK)).toBeCloseTo(1)
    expect(normalizationScale(0.45)).toBeCloseTo(NORMALIZED_PEAK / 0.45)
    // Loud sources come DOWN toward the target too.
    expect(normalizationScale(1)).toBeCloseTo(0.9)
    // Quiet audio is never boosted more than the cap…
    expect(normalizationScale(0.05)).toBe(MAX_NORMALIZATION_BOOST)
    // …and near-silence (dead mic) is left alone entirely.
    expect(normalizationScale(0.001)).toBe(1)
    expect(normalizationScale(0)).toBe(1)
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

  it('blends complementary shares: music at g, clip at 1 − g', async () => {
    const slice = [new Float32Array([0.6, 0.6, 0.6, 0.6])]
    const mixer = createBackgroundMixer(
      sourceOf([[new Float32Array([0.4, 0.4, 0.4, 0.4])]]),
      48000,
    )
    // 30% music: out = 0.6·0.7 + 0.4·0.3 = 0.54.
    await mixer.mixInto(slice, 0, flatEnvelope(0.3))
    for (const sample of slice[0]) {
      expect(sample).toBeCloseTo(0.6 * 0.7 + 0.4 * 0.3)
    }
  })

  it('applies the foreground normalization scale to the clip side only', async () => {
    const slice = [new Float32Array([0.2, 0.2])]
    const mixer = createBackgroundMixer(
      sourceOf([[new Float32Array([0.4, 0.4])]]),
      48000,
    )
    // Clip normalized 2×: out = 0.2·2·0.5 + 0.4·0.5 = 0.4.
    await mixer.mixInto(slice, 0, flatEnvelope(0.5), 2)
    for (const sample of slice[0]) {
      expect(sample).toBeCloseTo(0.4)
    }
  })

  it('eases the clip back to full volume when the playlist runs out', async () => {
    // 1 frame = 30ms (sampleRate ~33.33) would be awkward; use sampleRate 10
    // so the 300ms end ramp spans exactly 3 frames.
    const mixer = createBackgroundMixer(
      sourceOf([[new Float32Array([0, 0])]]), // 2 frames of silent music
      10,
    )
    const slice = [new Float32Array(6).fill(0.6)]
    await mixer.mixInto(slice, 0, flatEnvelope(0.8))
    // Frames 0–1: clip at 1 − 0.8 = 0.2 share. From frame 2 the playlist is
    // over and the clip ramps 0.2 → 1 over 3 frames.
    expect(Array.from(slice[0]).map((v) => Number(v.toFixed(2)))).toEqual([
      0.12, 0.12, 0.12, 0.28, 0.44, 0.6,
    ])
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

  it('spreads a mono track across stereo slices and hard-clamps the blend', async () => {
    const slice = [new Float32Array([0.9]), new Float32Array([-0.9])]
    const mixer = createBackgroundMixer(sourceOf([[new Float32Array([1])]]), 48000)
    // An extreme normalization boost is the only way past 1 now that the
    // shares themselves are complementary: 0.9·4·0.5 + 1·0.5 = 2.3 → 1.
    await mixer.mixInto(slice, 0, flatEnvelope(0.5), 4)
    expect(slice[0][0]).toBe(1)
    expect(slice[1][0]).toBe(-1)
  })

  it('leaves slices untouched when the music share is zero', async () => {
    const slice = [new Float32Array([0.3, 0.3])]
    const before = Array.from(slice[0])
    const mixer = createBackgroundMixer(sourceOf([[new Float32Array([0.5, 0.5])]]), 48000)
    await mixer.mixInto(slice, 0, flatEnvelope(0))
    expect(Array.from(slice[0])).toEqual(before)
  })

  it('scales the music side by the track level, leaving the clip side alone', async () => {
    const slice = [new Float32Array([0.6, 0.6])]
    const mixer = createBackgroundMixer(
      {
        ...sourceOf([[new Float32Array([0.4, 0.4])]]),
        getTrackPlayback: () => ({ volume: 0.5, fadeIn: false, fadeOut: false }),
      },
      48000,
    )
    // out = clip·(1 − g) + music·g·level = 0.6·0.5 + 0.4·0.5·0.5 = 0.4.
    await mixer.mixInto(slice, 0, flatEnvelope(0.5))
    for (const sample of slice[0]) {
      expect(sample).toBeCloseTo(0.4)
    }
  })

  it('fades a mid-film track in and an early-ending track out', async () => {
    // sampleRate 10: FADE_IN_MS (800ms) = 8 frames, FADE_OUT_MS (1200ms) =
    // 12 frames, both clamped to half of each 4-frame track (2 frames).
    const mixer = createBackgroundMixer(
      {
        ...sourceOf([
          [new Float32Array(4).fill(0.4)],
          [new Float32Array(4).fill(0.4)],
        ]),
        getTrackPlayback: () => ({ volume: 1, fadeIn: true, fadeOut: true }),
        totalFrames: 100,
      },
      10,
    )
    const slice = [new Float32Array(8)]
    await mixer.mixInto(slice, 0, flatEnvelope(1))
    const samples = Array.from(slice[0]).map((v) => Number(v.toFixed(2)))
    // Track 0 starts the film — its fade-in belongs to the share envelope,
    // so it opens at full level; its end (before the film's) fades out.
    expect(samples.slice(0, 2)).toEqual([0.4, 0.4])
    expect(samples[2]).toBeCloseTo(0.4 * (2 / 2), 2)
    expect(samples[3]).toBeCloseTo(0.4 * (1 / 2), 2)
    // Track 1 starts mid-film — it fades in…
    expect(samples[4]).toBeCloseTo(0, 2)
    expect(samples[5]).toBeCloseTo(0.4 * (1 / 2), 2)
    // …and fades out at its own end.
    expect(samples[6]).toBeCloseTo(0.4 * (2 / 2), 2)
    expect(samples[7]).toBeCloseTo(0.4 * (1 / 2), 2)
  })

  it('skips a track\u2019s own fade-out when the film cuts it off', async () => {
    const mixer = createBackgroundMixer(
      {
        ...sourceOf([[new Float32Array(4).fill(0.4)]]),
        getTrackPlayback: () => ({ volume: 1, fadeIn: true, fadeOut: true }),
        // The film ends where (or before) the track does — the share
        // envelope's film-edge fade covers that cut instead.
        totalFrames: 4,
      },
      10,
    )
    const slice = [new Float32Array(4)]
    await mixer.mixInto(slice, 0, flatEnvelope(1))
    expect(Array.from(slice[0]).map((v) => Number(v.toFixed(2)))).toEqual([
      0.4, 0.4, 0.4, 0.4,
    ])
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
