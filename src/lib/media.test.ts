import { afterEach, describe, expect, it, vi } from 'vitest'

// The recording mime preference is cached at module scope (it runs inside
// the pointerdown that starts every take), so each test re-imports a fresh
// module instance via vi.resetModules — a top-level import would share one
// cache across tests.

class FakeMediaRecorder {
  static probes: string[] = []
  static supported: Set<string> = new Set()
  static isTypeSupported(type: string): boolean {
    FakeMediaRecorder.probes.push(type)
    return FakeMediaRecorder.supported.has(type)
  }
}

async function freshPickRecordingMimeType() {
  vi.resetModules()
  const media = await import('./media')
  return media.pickRecordingMimeType
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeMediaRecorder.probes = []
  FakeMediaRecorder.supported = new Set()
})

describe('pickRecordingMimeType', () => {
  it('probes the platform once and serves later takes from the cache', async () => {
    FakeMediaRecorder.supported = new Set(['video/webm;codecs=vp9,opus'])
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    const pick = await freshPickRecordingMimeType()

    const first = pick()
    const probesAfterFirst = FakeMediaRecorder.probes.length
    expect(first).toBe('video/webm;codecs=vp9,opus')
    expect(probesAfterFirst).toBeGreaterThan(0)

    expect(pick()).toBe(first)
    expect(pick()).toBe(first)
    expect(FakeMediaRecorder.probes.length).toBe(probesAfterFirst)
  })

  it('caches the empty result when nothing is supported', async () => {
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    const pick = await freshPickRecordingMimeType()

    expect(pick()).toBe('')
    const probesAfterFirst = FakeMediaRecorder.probes.length
    expect(pick()).toBe('')
    expect(FakeMediaRecorder.probes.length).toBe(probesAfterFirst)
  })
})
