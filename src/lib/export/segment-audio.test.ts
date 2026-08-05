import { describe, expect, it } from 'vitest'
import {
  CROSSFADE_HALF_MS,
  CROSSFADE_MS,
  EDGE_FADE_MS,
  flushCarry,
  sliceSegmentAudio,
} from './segment-audio'

const RATE = 48000
const OVERLAP_FRAMES = (CROSSFADE_MS / 1000) * RATE
const HALF_FRAMES = (CROSSFADE_HALF_MS / 1000) * RATE
const EDGE_FRAMES = (EDGE_FADE_MS / 1000) * RATE

function frames(ms: number): number {
  return Math.round((ms / 1000) * RATE)
}

/** Mono constant-value source of `ms` milliseconds. */
function constantSource(ms: number, value = 1): Float32Array[] {
  return [new Float32Array(frames(ms)).fill(value)]
}

function slice(
  overrides: Partial<Parameters<typeof sliceSegmentAudio>[0]>,
): ReturnType<typeof sliceSegmentAudio> {
  return sliceSegmentAudio({
    source: constantSource(1000),
    startMs: 0,
    segmentMs: 1000,
    sampleRate: RATE,
    channelCount: 2,
    carryIn: null,
    hasNext: false,
    ...overrides,
  })
}

describe('sliceSegmentAudio', () => {
  it('produces exactly the segment duration when the film is one clip', () => {
    const { channels, carryOut } = slice({})
    expect(channels).toHaveLength(2)
    expect(channels[0]).toHaveLength(frames(1000))
    expect(carryOut).toBeNull()
    // Body at full gain; film edges ramp from/to silence.
    expect(channels[0][frames(500)]).toBe(1)
    expect(channels[0][0]).toBe(0)
    expect(channels[0][frames(1000) - 1]).toBe(0)
  })

  it('withholds the last CROSSFADE_MS as carry when a segment follows', () => {
    const { channels, carryOut } = slice({ hasNext: true })
    expect(channels[0]).toHaveLength(frames(1000) - OVERLAP_FRAMES)
    // The joint tail is NOT faded — it continues into the carry.
    expect(channels[0][channels[0].length - 1]).toBe(1)
    expect(carryOut).not.toBeNull()
    expect(carryOut![0]).toHaveLength(OVERLAP_FRAMES)
    expect(Array.from(carryOut![0])).toEqual(Array(OVERLAP_FRAMES).fill(1))
  })

  it('respects the trim-in point', () => {
    const source = [new Float32Array(frames(1000))]
    source[0][frames(500)] = 0.75
    const { channels } = slice({ source, startMs: 400, segmentMs: 600 })
    expect(channels[0][frames(100)]).toBe(0.75)
  })

  it('never withholds material past the trim-out point', () => {
    // Source continues after the segment window with a loud marker; the
    // carry must come from inside the window only.
    const source = [new Float32Array(frames(1000)).fill(1)]
    source[0].fill(9, frames(500))
    const { carryOut } = slice({ source, segmentMs: 500, hasNext: true })
    expect(Math.max(...carryOut![0])).toBe(1)
  })

  it('crossfades a joint with constant power instead of dipping to silence', () => {
    const a = slice({ hasNext: true })
    const b = slice({ carryIn: a.carryOut })
    // Equal-gain sources: everywhere in the overlap sin+cos ∈ [1, √2] —
    // the joint never gets quieter than either side alone.
    const mixed = Array.from(b.channels[0].slice(0, OVERLAP_FRAMES))
    expect(Math.min(...mixed)).toBeGreaterThanOrEqual(1)
    expect(Math.max(...mixed)).toBeLessThanOrEqual(Math.SQRT2 + 1e-6)
    // Mid-joint both sides contribute equally (~0.707 each).
    expect(mixed[HALF_FRAMES]).toBeCloseTo(Math.SQRT2, 2)
    // After the overlap the incoming clip is at full gain.
    expect(b.channels[0][OVERLAP_FRAMES]).toBe(1)
  })

  it('hands the outgoing tail to the incoming clip even when it is silent', () => {
    const a = slice({ hasNext: true })
    const b = slice({ source: null, carryIn: a.carryOut })
    // The joint still fades A out across B's (silent) head — no hard cut.
    expect(b.channels[0][0]).toBeGreaterThan(0.99)
    expect(b.channels[0][OVERLAP_FRAMES - 1]).toBeLessThan(0.05)
    expect(b.channels[0][OVERLAP_FRAMES]).toBe(0)
  })

  it('pads with silence and fades out when the audio is shorter than the video', () => {
    const { channels } = slice({ source: constantSource(600), segmentMs: 1000 })
    expect(channels[0][frames(600)]).toBe(0)
    expect(channels[0][frames(600) - 1]).toBe(0)
    expect(channels[0][frames(600) - EDGE_FRAMES]).toBeCloseTo(1, 1)
  })

  it('keeps audio and video durations identical across a whole film', () => {
    // Three clips joined by two crossfades: the video gives up
    // CROSSFADE_HALF_MS per side of each joint, and the appended audio
    // buffers must add up to exactly the same total.
    const durations = [1000, 700, 1300]
    let audioFrames = 0
    let videoFrames = 0
    let carry: Float32Array[] | null = null
    durations.forEach((ms, i) => {
      const hasNext = i < durations.length - 1
      const result = slice({ source: constantSource(ms), segmentMs: ms, carryIn: carry, hasNext })
      carry = result.carryOut
      audioFrames += result.channels[0].length
      videoFrames += frames(ms) - (carry ? HALF_FRAMES : 0) - (i > 0 ? HALF_FRAMES : 0)
    })
    expect(carry).toBeNull()
    expect(audioFrames).toBe(videoFrames)
    expect(audioFrames).toBe(frames(1000 + 700 + 1300) - 2 * OVERLAP_FRAMES)
  })

  it('spreads a mono source across both output channels', () => {
    const { channels } = slice({})
    expect(Array.from(channels[1])).toEqual(Array.from(channels[0]))
  })
})

describe('flushCarry', () => {
  it('emits half a crossfade fading to silence', () => {
    const a = slice({ hasNext: true })
    const flushed = flushCarry(a.carryOut!, RATE)
    expect(flushed[0]).toHaveLength(HALF_FRAMES)
    expect(flushed[0][0]).toBeCloseTo(1, 2)
    expect(flushed[0][HALF_FRAMES - 1]).toBe(0)
  })

  it('restores the audio/video duration match when later segments drop', () => {
    // One emitted segment that expected a joint: video kept
    // durationMs − CROSSFADE_HALF_MS, audio must add up to the same.
    const a = slice({ segmentMs: 1000, hasNext: true })
    const flushed = flushCarry(a.carryOut!, RATE)
    expect(a.channels[0].length + flushed[0].length).toBe(frames(1000) - HALF_FRAMES)
  })
})
