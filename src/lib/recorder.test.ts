import { describe, expect, it } from 'vitest'
import { takeTrimEndMs } from './recorder'

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
