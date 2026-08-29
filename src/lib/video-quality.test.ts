import { afterEach, describe, expect, it } from 'vitest'
import {
  activeVideoQuality,
  captureVideoConstraints,
  recordingVideoBitsPerSecond,
  resetActiveVideoQualityForTests,
  resolveVideoQuality,
  setActiveVideoQuality,
  videoBitrateFor,
} from './video-quality'

afterEach(() => {
  resetActiveVideoQualityForTests()
})

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
  it('assumes the active preset size when the track has not reported yet', () => {
    expect(recordingVideoBitsPerSecond()).toBe(videoBitrateFor(1280, 720, 0.16))
    setActiveVideoQuality('high', true)
    expect(recordingVideoBitsPerSecond()).toBe(videoBitrateFor(1920, 1080, 0.16))
  })

  it('follows the live track size', () => {
    expect(recordingVideoBitsPerSecond(720, 1280)).toBe(videoBitrateFor(1280, 720, 0.16))
  })

  it('does not bill a 1080p track at High bitrate on Standard or Saver', () => {
    expect(recordingVideoBitsPerSecond(1080, 1920, 'standard')).toBe(
      videoBitrateFor(1280, 720, 0.16),
    )
    expect(recordingVideoBitsPerSecond(1080, 1920, 'saver')).toBe(
      videoBitrateFor(1280, 720, 0.08),
    )
    expect(recordingVideoBitsPerSecond(1080, 1920, 'standard')).toBeLessThan(
      recordingVideoBitsPerSecond(1080, 1920, 'high'),
    )
  })

  it('uses the saver bitrate without dropping below 30fps math', () => {
    expect(recordingVideoBitsPerSecond(720, 1280, 'saver')).toBe(
      videoBitrateFor(720, 1280, 0.08),
    )
    expect(recordingVideoBitsPerSecond(720, 1280, 'saver')).toBeLessThan(
      recordingVideoBitsPerSecond(720, 1280, 'standard'),
    )
  })

  it('assumes the preset frame size when the track is silent', () => {
    expect(recordingVideoBitsPerSecond(undefined, undefined, 'standard')).toBe(
      videoBitrateFor(1280, 720, 0.16),
    )
  })
})

describe('video quality presets', () => {
  it('defaults free users to standard and Plus users to high', () => {
    expect(resolveVideoQuality(undefined)).toBe('standard')
    expect(resolveVideoQuality('ultra')).toBe('standard')
    expect(resolveVideoQuality(undefined, true)).toBe('high')
    expect(resolveVideoQuality('saver')).toBe('saver')
    expect(resolveVideoQuality('saver', true)).toBe('saver')
  })

  it('clamps a stored high preset back to standard without Plus', () => {
    expect(resolveVideoQuality('high')).toBe('standard')
    expect(resolveVideoQuality('high', true)).toBe('high')
  })

  it('keeps 30fps and only changes the capture size', () => {
    expect(captureVideoConstraints('high')).toEqual({
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    })
    expect(captureVideoConstraints('standard')).toEqual({
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    })
    expect(captureVideoConstraints('saver').frameRate).toEqual({ ideal: 30 })
    expect(captureVideoConstraints('saver').width).toEqual({ ideal: 1280 })
  })

  it('hydrates the in-memory capture preset used by camera and recorder', () => {
    expect(activeVideoQuality()).toBe('standard')
    expect(setActiveVideoQuality('high')).toBe('standard')
    expect(setActiveVideoQuality('high', true)).toBe('high')
    expect(activeVideoQuality()).toBe('high')
    expect(captureVideoConstraints()).toEqual(captureVideoConstraints('high'))
    expect(recordingVideoBitsPerSecond()).toBe(
      recordingVideoBitsPerSecond(undefined, undefined, 'high'),
    )
  })
})
