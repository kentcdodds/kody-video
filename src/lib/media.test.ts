import { afterEach, describe, expect, it, vi } from 'vitest'
import { pickRecordingMimeType, resetRecordingMimeTypeForTests } from './media'

// The recording mime preference is cached at module scope (it runs inside
// the pointerdown that starts every take); resetRecordingMimeTypeForTests
// clears the cache between tests — the browser module graph cannot be
// re-imported per test the way vi.resetModules allowed in Node.

class FakeMediaRecorder {
  static probes: string[] = []
  static supported: Set<string> = new Set()
  static isTypeSupported(type: string): boolean {
    FakeMediaRecorder.probes.push(type)
    return FakeMediaRecorder.supported.has(type)
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetRecordingMimeTypeForTests()
  FakeMediaRecorder.probes = []
  FakeMediaRecorder.supported = new Set()
})

describe('pickRecordingMimeType', () => {
  it('probes the platform once and serves later takes from the cache', () => {
    FakeMediaRecorder.supported = new Set(['video/webm;codecs=vp9,opus'])
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    resetRecordingMimeTypeForTests()

    const first = pickRecordingMimeType()
    const probesAfterFirst = FakeMediaRecorder.probes.length
    expect(first).toBe('video/webm;codecs=vp9,opus')
    expect(probesAfterFirst).toBeGreaterThan(0)

    expect(pickRecordingMimeType()).toBe(first)
    expect(pickRecordingMimeType()).toBe(first)
    expect(FakeMediaRecorder.probes.length).toBe(probesAfterFirst)
  })

  it('caches the empty result when nothing is supported', () => {
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    resetRecordingMimeTypeForTests()

    expect(pickRecordingMimeType()).toBe('')
    const probesAfterFirst = FakeMediaRecorder.probes.length
    expect(pickRecordingMimeType()).toBe('')
    expect(FakeMediaRecorder.probes.length).toBe(probesAfterFirst)
  })
})
