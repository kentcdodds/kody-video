import { describe, expect, it } from 'vitest'
import { isAtKeptWindowEnd, restartSeekHasLanded } from './preview-window'

describe('isAtKeptWindowEnd', () => {
  it('stops at the kept end once playback is settled', () => {
    expect(
      isAtKeptWindowEnd(2.99, 3, { seeking: false, restarting: false }),
    ).toBe(true)
    expect(
      isAtKeptWindowEnd(2.5, 3, { seeking: false, restarting: false }),
    ).toBe(false)
  })

  it('ignores a stale playhead while seeking or restarting from the start', () => {
    expect(
      isAtKeptWindowEnd(3, 3, { seeking: true, restarting: false }),
    ).toBe(false)
    expect(
      isAtKeptWindowEnd(3, 3, { seeking: false, restarting: true }),
    ).toBe(false)
  })
})

describe('restartSeekHasLanded', () => {
  it('clears once currentTime is near the trim start', () => {
    expect(restartSeekHasLanded(0.5, 0.5, 3)).toBe(true)
    expect(restartSeekHasLanded(0.55, 0.5, 3)).toBe(true)
    expect(restartSeekHasLanded(2.9, 0.5, 3)).toBe(false)
    expect(restartSeekHasLanded(0.1, 0, 0.1)).toBe(false)
    expect(restartSeekHasLanded(0, 0, 0.1)).toBe(true)
  })
})
