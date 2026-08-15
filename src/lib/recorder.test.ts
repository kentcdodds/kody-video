import { describe, expect, it } from 'vitest'
import { takeFallbackDurationMs, takeTrimEndMs, takeTrimStartMs } from './recorder'

describe('takeTrimEndMs', () => {
  it('walks the trim-out back by the real stop grace', () => {
    expect(takeTrimEndMs(2200, 200)).toBe(2000)
  })

  it('uses the actual (late-firing) grace, not the nominal one', () => {
    expect(takeTrimEndMs(2350, 350)).toBe(2000)
  })

  it('never trims a short take below the minimum take length', () => {
    // A 130ms hold + grace: trimming the full grace back would leave a
    // sliver the export planner drops entirely.
    expect(takeTrimEndMs(330, 200)).toBe(130)
    expect(takeTrimEndMs(250, 200)).toBe(120)
  })

  it('never exceeds the measured media duration', () => {
    expect(takeTrimEndMs(100, 0)).toBe(100)
  })
})

describe('takeTrimStartMs', () => {
  it('skips adopted pre-roll so the kept range is the wall-clock hold', () => {
    expect(takeTrimStartMs(4300, 2000)).toBe(2300)
  })

  it('is 0 for a cold start (take length matches the trimmed media)', () => {
    expect(takeTrimStartMs(2000, 2000)).toBe(0)
    expect(takeTrimStartMs(2000, 2100)).toBe(0)
  })

  it('is 0 when there is no take length', () => {
    expect(takeTrimStartMs(2000, 0)).toBe(0)
  })
})

describe('takeFallbackDurationMs', () => {
  it('keeps adopted pre-roll in the blob length so trim-in can skip it', () => {
    // Warm session started 800ms before press; 2000ms hold; 200ms grace.
    const fallbackMs = takeFallbackDurationMs(0, 3000, 2000)
    expect(fallbackMs).toBe(3000)
    const trimEndMs = takeTrimEndMs(fallbackMs, 200)
    expect(trimEndMs).toBe(2800)
    expect(takeTrimStartMs(trimEndMs, 2000)).toBe(800)
  })

  it('matches a cold start (no pre-roll) after walking back grace', () => {
    const fallbackMs = takeFallbackDurationMs(0, 2200, 2000)
    expect(fallbackMs).toBe(2200)
    const trimEndMs = takeTrimEndMs(fallbackMs, 200)
    expect(trimEndMs).toBe(2000)
    expect(takeTrimStartMs(trimEndMs, 2000)).toBe(0)
  })

  it('never reports shorter than the wall-clock hold', () => {
    expect(takeFallbackDurationMs(1000, 1500, 2000)).toBe(2000)
  })
})
