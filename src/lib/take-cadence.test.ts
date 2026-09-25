import { describe, expect, it } from 'vitest'
import { makeTestClipBlob } from './testing/make-test-clip'
import {
  analyzeAudioContinuity,
  analyzeFrameCadence,
  gapBucket,
  missingFramesInGap,
  readTakeTimestamps,
} from './take-cadence'

/** Steady 30fps timestamps (seconds) for `ms`, with optional removals. */
function steady(ms: number, drop: (index: number) => boolean = () => false): number[] {
  const out: number[] = []
  for (let i = 0; i * (1000 / 30) < ms; i += 1) {
    if (!drop(i)) out.push((i * (1000 / 30)) / 1000)
  }
  return out
}

describe('missingFramesInGap', () => {
  it('treats jitter up to half an interval as on time', () => {
    expect(missingFramesInGap(33.3, 33.3)).toBe(0)
    expect(missingFramesInGap(48, 33.3)).toBe(0)
  })

  it('counts whole missing frames', () => {
    expect(missingFramesInGap(66.7, 33.3)).toBe(1)
    expect(missingFramesInGap(133.3, 33.3)).toBe(3)
  })
})

describe('gapBucket', () => {
  it('buckets missing-frame counts', () => {
    expect([0, 1, 2, 3, 4, 8, 9, 30].map(gapBucket)).toEqual([
      '0',
      '1',
      '2-3',
      '2-3',
      '4-8',
      '4-8',
      '9+',
      '9+',
    ])
  })
})

describe('analyzeFrameCadence', () => {
  it('reports a clean 30fps take as smooth', () => {
    const cadence = analyzeFrameCadence(steady(4000), { startMs: 0, endMs: 4000 })
    expect(cadence.frames).toBe(120)
    expect(cadence.expectedFrames).toBe(120)
    expect(cadence.droppedFrames).toBe(0)
    expect(cadence.stalls).toBe(0)
    expect(cadence.fps).toBe(30)
    expect(cadence.medianIntervalMs).toBeCloseTo(33.3, 0)
    expect(cadence.gapHistogram['0']).toBe(119)
  })

  it('counts a mid-take stall and locates it', () => {
    // Frames 60..65 missing: a 7-interval gap starting at ~1967ms.
    const cadence = analyzeFrameCadence(
      steady(4000, (i) => i >= 60 && i <= 65),
      { startMs: 0, endMs: 4000 },
    )
    expect(cadence.droppedFrames).toBe(6)
    expect(cadence.stalls).toBe(1)
    expect(cadence.gapHistogram['4-8']).toBe(1)
    expect(cadence.maxGapMs).toBe(233)
    expect(cadence.worstGaps[0]).toMatchObject({ atMs: 1967, missing: 6 })
  })

  it('analyzes only the kept window (pre-roll and grace are not the memory)', () => {
    // A stall inside the pre-roll must not count against the kept range.
    const stamps = steady(3000, (i) => i >= 5 && i <= 12)
    const cadence = analyzeFrameCadence(stamps, { startMs: 1000, endMs: 2800 })
    expect(cadence.droppedFrames).toBe(0)
    expect(cadence.frames).toBe(54)
  })

  it('flags a frozen head inside the kept range', () => {
    const stamps = steady(3000).filter((ts) => ts >= 0.2)
    const cadence = analyzeFrameCadence(stamps, { startMs: 0, endMs: 3000 })
    expect(cadence.headGapMs).toBe(200)
    expect(cadence.droppedFrames).toBe(6)
    expect(cadence.worstGaps[0]).toMatchObject({ atMs: 0 })
  })

  it('sees a steady low camera rate in the median interval', () => {
    const fifteen: number[] = []
    for (let i = 0; i < 45; i += 1) fifteen.push(i / 15)
    const cadence = analyzeFrameCadence(fifteen, { startMs: 0, endMs: 3000 })
    expect(cadence.fps).toBe(15)
    expect(cadence.medianIntervalMs).toBeCloseTo(66.7, 0)
    expect(cadence.droppedFrames).toBeGreaterThanOrEqual(44)
  })

  it('handles reordered presentation timestamps (B-frames)', () => {
    const stamps = steady(1000)
    const reordered = [...stamps]
    ;[reordered[3], reordered[4]] = [reordered[4]!, reordered[3]!]
    expect(analyzeFrameCadence(reordered).droppedFrames).toBe(0)
  })

  it('reports an empty window as fully dropped', () => {
    const cadence = analyzeFrameCadence([], { startMs: 0, endMs: 1000 })
    expect(cadence.frames).toBe(0)
    expect(cadence.droppedFrames).toBe(30)
  })
})

describe('analyzeAudioContinuity', () => {
  it('finds discontinuities between audio packets', () => {
    const packets = Array.from({ length: 50 }, (_, i) => ({
      timestampSec: i * 0.02 + (i >= 30 ? 0.06 : 0),
      durationSec: 0.02,
    }))
    const audio = analyzeAudioContinuity(packets)
    expect(audio.packets).toBe(50)
    expect(audio.gaps).toBe(1)
    expect(audio.maxGapMs).toBe(60)
    expect(audio.gapAtMs).toEqual([600])
  })
})

describe('readTakeTimestamps', () => {
  it('reads packet timings from a real recorded WebM without decoding', async () => {
    // The fixture encodes exactly ceil(1.5s × 15fps) frames on a 15fps grid.
    const blob = await makeTestClipBlob(1500, 440)
    const stamps = await readTakeTimestamps(blob)
    expect(stamps.videoSec).toHaveLength(23)
    expect(stamps.videoCodec).toMatch(/vp8|vp09/)
    expect(stamps.audio.length).toBeGreaterThan(10)
    const cadence = analyzeFrameCadence(stamps.videoSec, undefined, 15)
    expect(cadence.droppedFrames).toBe(0)
    expect(cadence.fps).toBe(15)
    expect(analyzeAudioContinuity(stamps.audio).gaps).toBe(0)
  })
})
