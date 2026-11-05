import { describe, expect, it } from 'vitest'
import { estimateRemainingMs, formatTimeLeft } from './export-eta'

describe('estimateRemainingMs', () => {
  it('waits for enough elapsed time and progress', () => {
    expect(estimateRemainingMs({ startProgress: 0, progress: 0.5, elapsedMs: 1000 })).toBeNull()
    expect(estimateRemainingMs({ startProgress: 0, progress: 0.01, elapsedMs: 5000 })).toBeNull()
    expect(estimateRemainingMs({ startProgress: 0, progress: 1, elapsedMs: 5000 })).toBeNull()
  })

  it('extrapolates from the progress made since the baseline', () => {
    expect(estimateRemainingMs({ startProgress: 0, progress: 0.25, elapsedMs: 10_000 })).toBe(
      30_000,
    )
    expect(estimateRemainingMs({ startProgress: 0.2, progress: 0.6, elapsedMs: 8000 })).toBeCloseTo(
      8000,
    )
  })
})

describe('formatTimeLeft', () => {
  it('rounds to friendly units', () => {
    expect(formatTimeLeft(4000)).toBe('A few seconds left')
    expect(formatTimeLeft(21_000)).toBe('About 25 sec left')
    expect(formatTimeLeft(150_000)).toBe('About 3 min left')
    expect(formatTimeLeft(60 * 60_000)).toBe('About 1 hr left')
    expect(formatTimeLeft(95 * 60_000)).toBe('About 1 hr 35 min left')
  })
})
