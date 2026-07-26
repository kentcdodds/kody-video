import { describe, expect, it } from 'vitest'
import { effectiveDurationMs, formatDuration } from './types'

describe('duration helpers', () => {
  it('computes effective duration from trim points', () => {
    expect(
      effectiveDurationMs({
        durationMs: 5000,
        trimStartMs: 1000,
        trimEndMs: 3500,
      }),
    ).toBe(2500)
  })

  it('formats short and long durations', () => {
    expect(formatDuration(1500)).toBe('1.5s')
    expect(formatDuration(61500)).toBe('1:01.5')
  })
})
