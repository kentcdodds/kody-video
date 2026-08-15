import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fileFromBlob,
  pickRecordingMimeType,
  resetRecordingMimeTypeForTests,
  shareFile,
} from './media'

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

describe('fileFromBlob', () => {
  it('stamps lastModified so share targets keep the capture time', () => {
    const file = fileFromBlob(new Blob(['mp4'], { type: 'video/mp4' }), 'beach.mp4', 1_700_000_000_000)
    expect(file).toBeInstanceOf(File)
    expect(file.name).toBe('beach.mp4')
    expect(file.type).toBe('video/mp4')
    expect(file.lastModified).toBe(1_700_000_000_000)
  })

  it('omits invalid stamps so the browser defaults to now', () => {
    const before = Date.now()
    expect(fileFromBlob(new Blob(['x'], { type: 'video/mp4' }), 'x.mp4').lastModified).toBeGreaterThanOrEqual(
      before,
    )
    expect(
      fileFromBlob(new Blob(['x'], { type: 'video/mp4' }), 'x.mp4', Number.NaN).lastModified,
    ).toBeGreaterThanOrEqual(before)
    expect(fileFromBlob(new Blob(['x'], { type: 'video/mp4' }), 'x.mp4', 0).lastModified).toBeGreaterThanOrEqual(
      before,
    )
  })
})

describe('shareFile', () => {
  it('hands Web Share a File stamped with the capture time', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, share })

    await expect(
      shareFile(new Blob(['x'], { type: 'video/mp4' }), 'film.mp4', 1_234_000),
    ).resolves.toBe('shared')

    expect(share).toHaveBeenCalledOnce()
    const file = share.mock.calls[0]?.[0]?.files?.[0] as File
    expect(file).toBeInstanceOf(File)
    expect(file.name).toBe('film.mp4')
    expect(file.lastModified).toBe(1_234_000)
  })
})
