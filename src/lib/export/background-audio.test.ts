import { describe, expect, it } from 'vitest'
import {
  EDGE_RAMP_MS,
  FADE_IN_MS,
  FADE_OUT_MS,
  MAX_NORMALIZATION_BOOST,
  NORMALIZED_PEAK,
  VOLUME_RAMP_MS,
  applyGainEnvelope,
  boundaryRampHalfMs,
  channelPeak,
  createBackgroundMixer,
  filmEdgeFades,
  gainAtMs,
  normalizationScale,
  planSegmentGain,
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

  it('holds the level flat at film edges for the clip envelope', () => {
    // 'hold' is the clip-sound edge behavior: no fade to silence at the
    // film's edges (segment slicing already click-kills hard edges).
    const points = planSegmentGain({ volume: 0.7, durationMs: 8000, fades: 'hold' })
    expect(gainAtMs(points, 0)).toBeCloseTo(0.7)
    expect(gainAtMs(points, 4000)).toBeCloseTo(0.7)
    expect(gainAtMs(points, 8000)).toBeCloseTo(0.7)
  })

  it('still ramps between neighbors under hold edges', () => {
    const half = boundaryRampHalfMs(4000, 4000)
    const incoming = planSegmentGain({
      volume: 0.2,
      durationMs: 4000,
      entry: { fromVolume: 1, halfMs: half },
      fades: 'hold',
    })
    expect(gainAtMs(incoming, 0)).toBeCloseTo(0.6)
    expect(gainAtMs(incoming, half)).toBeCloseTo(0.2)
    expect(gainAtMs(incoming, 4000)).toBeCloseTo(0.2)
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
})

describe('filmEdgeFades', () => {
  const blob = new Blob(['x'])
  const playlist = { fadeIn: true, fadeOut: true }

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

describe('applyGainEnvelope', () => {
  const flat = (volume: number): GainPoint[] => [
    { tMs: 0, volume },
    { tMs: 1_000_000, volume },
  ]

  it('scales the slice by scale × envelope', () => {
    const channels = [new Float32Array([0.4, 0.4])]
    applyGainEnvelope(channels, flat(0.5), 48000, 1.5)
    for (const sample of channels[0]) {
      expect(sample).toBeCloseTo(0.4 * 0.5 * 1.5)
    }
  })

  it('follows the envelope over time and hard-clamps', () => {
    // 1 frame = 1ms at sampleRate 1000 for readable positions.
    const channels = [new Float32Array([0.5, 0.5, 0.5])]
    applyGainEnvelope(
      channels,
      [
        { tMs: 0, volume: 0 },
        { tMs: 2, volume: 1 },
      ],
      1000,
      4,
    )
    expect(channels[0][0]).toBeCloseTo(0)
    expect(channels[0][1]).toBeCloseTo(1) // 0.5·0.5·4 = 1 exactly
    expect(channels[0][2]).toBe(1) // 0.5·1·4 = 2 → clamped
  })

  it('is a no-op at unity gain', () => {
    const channels = [new Float32Array([0.3, -0.3])]
    const before = Array.from(channels[0])
    applyGainEnvelope(channels, flat(1), 48000)
    expect(Array.from(channels[0])).toEqual(before)
  })
})

describe('createBackgroundMixer', () => {
  const flatEnvelope = (volume: number): GainPoint[] => [
    { tMs: 0, volume },
    { tMs: 1_000_000, volume },
  ]

  /** Flat music + clip envelopes (clip defaults to full volume). */
  const envelopes = (music: number, clip = 1) => ({
    music: flatEnvelope(music),
    clip: flatEnvelope(clip),
  })

  function sourceOf(tracks: Array<Float32Array[] | null>): SequentialBackgroundSource {
    return {
      trackCount: tracks.length,
      getTrack: (index) => Promise.resolve(tracks[index] ?? null),
    }
  }

  it('blends the two independent levels: clip at its volume, music at its own', async () => {
    const slice = [new Float32Array([0.6, 0.6, 0.6, 0.6])]
    const mixer = createBackgroundMixer(
      sourceOf([[new Float32Array([0.4, 0.4, 0.4, 0.4])]]),
      48000,
    )
    // Clip 70%, music 30%: out = 0.6·0.7 + 0.4·0.3 = 0.54.
    await mixer.mixInto(slice, 0, envelopes(0.3, 0.7))
    for (const sample of slice[0]) {
      expect(sample).toBeCloseTo(0.6 * 0.7 + 0.4 * 0.3)
    }
  })

  it('a quiet music level never ducks the clip side', async () => {
    const slice = [new Float32Array([0.6, 0.6])]
    const mixer = createBackgroundMixer(
      sourceOf([[new Float32Array([0.4, 0.4])]]),
      48000,
    )
    // Music ducked to 10%, clip at full: out = 0.6 + 0.4·0.1 = 0.64.
    await mixer.mixInto(slice, 0, envelopes(0.1))
    for (const sample of slice[0]) {
      expect(sample).toBeCloseTo(0.64)
    }
  })

  it('applies the foreground normalization scale to the clip side only', async () => {
    const slice = [new Float32Array([0.2, 0.2])]
    const mixer = createBackgroundMixer(
      sourceOf([[new Float32Array([0.4, 0.4])]]),
      48000,
    )
    // Clip normalized 2× at half volume: out = 0.2·2·0.5 + 0.4·0.5 = 0.4.
    await mixer.mixInto(slice, 0, envelopes(0.5, 0.5), 2)
    for (const sample of slice[0]) {
      expect(sample).toBeCloseTo(0.4)
    }
  })

  it('keeps the clip at its own level when the playlist runs out', async () => {
    const mixer = createBackgroundMixer(
      sourceOf([[new Float32Array([0.4, 0.4])]]), // 2 frames of music
      10,
    )
    const slice = [new Float32Array(6).fill(0.6)]
    await mixer.mixInto(slice, 0, envelopes(0.8, 0.5))
    // While the track plays: clip 0.6·0.5 + music 0.4·0.8 = 0.62. After the
    // playlist runs out only the clip envelope applies — music ending
    // changes nothing on the clip's side (the levels are independent).
    expect(Array.from(slice[0]).map((v) => Number(v.toFixed(2)))).toEqual([
      0.62, 0.62, 0.3, 0.3, 0.3, 0.3,
    ])
  })

  it('plays tracks one after the other and goes silent when they run out', async () => {
    // Track A: two frames of 0.2; track B: two frames of 0.6; film: 6 frames.
    const mixer = createBackgroundMixer(
      sourceOf([[new Float32Array([0.2, 0.2])], [new Float32Array([0.6, 0.6])]]),
      48000,
    )
    const slice = [new Float32Array(6)]
    await mixer.mixInto(slice, 0, envelopes(1))
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
    await mixer.mixInto(first, 0, envelopes(1))
    await mixer.mixInto(second, 2, envelopes(1))
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
    await mixer.mixInto(first, 0, envelopes(1))
    await mixer.mixInto(second, 2, {
      music: [
        { tMs: 0, volume: 0.5 },
        { tMs: 2, volume: 0.5 },
      ],
      clip: flatEnvelope(1),
    })
    expect(first[0][0]).toBeCloseTo(0.4)
    expect(second[0][0]).toBeCloseTo(0.2)
  })

  it('skips undecodable tracks and continues with the next', async () => {
    const mixer = createBackgroundMixer(
      sourceOf([null, [new Float32Array([0.4, 0.4])]]),
      48000,
    )
    const slice = [new Float32Array(3)]
    await mixer.mixInto(slice, 0, envelopes(0.5))
    expect(Array.from(slice[0]).map((v) => Number(v.toFixed(2)))).toEqual([0.2, 0.2, 0])
  })

  it('spreads a mono track across stereo slices and hard-clamps the blend', async () => {
    const slice = [new Float32Array([0.9]), new Float32Array([-0.9])]
    const mixer = createBackgroundMixer(sourceOf([[new Float32Array([1])]]), 48000)
    // Independent levels can sum past 1: 0.9·4·0.5 + 1·0.5 = 2.3 → 1.
    await mixer.mixInto(slice, 0, envelopes(0.5, 0.5), 4)
    expect(slice[0][0]).toBe(1)
    expect(slice[1][0]).toBe(-1)
  })

  it('leaves slices untouched when both levels are unity and zero', async () => {
    const slice = [new Float32Array([0.3, 0.3])]
    const before = Array.from(slice[0])
    const mixer = createBackgroundMixer(sourceOf([[new Float32Array([0.5, 0.5])]]), 48000)
    await mixer.mixInto(slice, 0, envelopes(0))
    expect(Array.from(slice[0])).toEqual(before)
  })

  it('scales the music side by the track volume, leaving the clip side alone', async () => {
    const slice = [new Float32Array([0.6, 0.6])]
    const mixer = createBackgroundMixer(
      {
        ...sourceOf([[new Float32Array([0.4, 0.4])]]),
        getTrackPlayback: () => ({ volume: 0.5, fadeIn: false, fadeOut: false }),
      },
      48000,
    )
    // out = clip·clipEnv + music·musicEnv·trackVolume
    //     = 0.6·0.5 + 0.4·0.5·0.5 = 0.4.
    await mixer.mixInto(slice, 0, envelopes(0.5, 0.5))
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
    await mixer.mixInto(slice, 0, envelopes(1))
    const samples = Array.from(slice[0]).map((v) => Number(v.toFixed(2)))
    // Track 0 starts the film — its fade-in belongs to the music envelope,
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
        // The film ends where (or before) the track does — the music
        // envelope's film-edge fade covers that cut instead.
        totalFrames: 4,
      },
      10,
    )
    const slice = [new Float32Array(4)]
    await mixer.mixInto(slice, 0, envelopes(1))
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
    await mixer.mixInto([new Float32Array(3)], 0, envelopes(0.5))
    expect(decoded).toEqual([0, 1])
    await mixer.mixInto([new Float32Array(3)], 3, envelopes(0.5))
    expect(decoded).toEqual([0, 1, 2])
  })
})
