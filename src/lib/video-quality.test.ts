import { describe, expect, it } from 'vitest'
import { recordingVideoBitsPerSecond, videoBitrateFor } from './video-quality'

describe('videoBitrateFor', () => {
  it('scales with pixels and stays in the 1080p band', () => {
    expect(videoBitrateFor(1080, 1920)).toBe(Math.round(1080 * 1920 * 30 * 0.16))
    expect(videoBitrateFor(1920, 1080)).toBe(Math.round(1920 * 1080 * 30 * 0.16))
    expect(videoBitrateFor(1080, 1920)).toBeGreaterThan(8_000_000)
    expect(videoBitrateFor(1080, 1920)).toBeLessThanOrEqual(12_000_000)
  })

  it('floors tiny outputs instead of spending a flat 4Mbps', () => {
    expect(videoBitrateFor(320, 568)).toBe(1_500_000)
  })
})

describe('recordingVideoBitsPerSecond', () => {
  it('assumes 1080p when the track has not reported size yet', () => {
    expect(recordingVideoBitsPerSecond()).toBe(videoBitrateFor(1920, 1080, 0.16))
  })

  it('follows the live track size', () => {
    expect(recordingVideoBitsPerSecond(720, 1280)).toBe(videoBitrateFor(720, 1280, 0.16))
  })
})
