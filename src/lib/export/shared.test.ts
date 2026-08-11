import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTestClipBlob } from '../testing/make-test-clip'
import {
  __isAudioDecodeFailureReportArmedForTests,
  AUDIO_PEAK_RETENTION_RATIO,
  AUDIO_SILENCE_PEAK,
  audioDecodeFailureDetail,
  blobForPlayback,
  boundedAudioMimeType,
  classifyOutputAudioPeak,
  decodeBlobAudio,
  decodeBlobAudioViaWebAudio,
  decodeClipAudio,
  isAutoplayBlockedError,
  isWebKitAudioDecoderNotFoundError,
  pickOutputSize,
  playExportVideo,
  prepareExportVideoElement,
  resampleAudioBuffer,
  resetAudioDiagnostics,
  resolveEncodeCanvas,
  unlockExportMediaPlayback,
  waitForPreviewCanvas,
} from './shared'

describe('pickOutputSize', () => {
  it('follows the source aspect, capped at 1280 on the long edge', () => {
    expect(pickOutputSize(1080, 1920)).toEqual({ width: 720, height: 1280 })
    expect(pickOutputSize(1920, 1080)).toEqual({ width: 1280, height: 720 })
    // Never upscales; keeps dimensions even.
    expect(pickOutputSize(321, 569)).toEqual({ width: 322, height: 570 })
  })

  it('forces a landscape project onto portrait sources by swapping dims', () => {
    expect(pickOutputSize(1080, 1920, 'landscape')).toEqual({ width: 1280, height: 720 })
    expect(pickOutputSize(320, 568, 'landscape')).toEqual({ width: 568, height: 320 })
    // Already landscape: untouched.
    expect(pickOutputSize(1920, 1080, 'landscape')).toEqual({ width: 1280, height: 720 })
  })

  it('forces a portrait project onto landscape sources by swapping dims', () => {
    expect(pickOutputSize(1920, 1080, 'portrait')).toEqual({ width: 720, height: 1280 })
    expect(pickOutputSize(1080, 1920, 'portrait')).toEqual({ width: 720, height: 1280 })
  })

  it('leaves square sources alone in both orientations', () => {
    expect(pickOutputSize(1000, 1000, 'landscape')).toEqual({ width: 1000, height: 1000 })
    expect(pickOutputSize(1000, 1000, 'portrait')).toEqual({ width: 1000, height: 1000 })
  })
})

describe('classifyOutputAudioPeak', () => {
  it('returns unknown when inputs never cleared the silence floor', () => {
    expect(classifyOutputAudioPeak(0, 0)).toBe('unknown')
    expect(classifyOutputAudioPeak(AUDIO_SILENCE_PEAK - 0.0001, 0)).toBe('unknown')
  })

  it('returns ok when the output peak clears the absolute silence floor', () => {
    expect(classifyOutputAudioPeak(0.5, AUDIO_SILENCE_PEAK)).toBe('ok')
    expect(classifyOutputAudioPeak(0.5, 0.2)).toBe('ok')
  })

  it('treats near-floor encode attenuation as ok, not a silent mux', () => {
    // KODY-VIDEO-K: Android Chrome WebCodecs, input 0.0065 → output 0.0048.
    // Absolute floor alone false-positive'd; relative retention keeps it.
    expect(classifyOutputAudioPeak(0.0065, 0.0048)).toBe('ok')
    expect(classifyOutputAudioPeak(0.01, 0.01 * AUDIO_PEAK_RETENTION_RATIO)).toBe('ok')
  })

  it('flags a collapsed output peak as a silent encode/mux fault', () => {
    expect(classifyOutputAudioPeak(0.5, 0)).toBe('silent')
    expect(classifyOutputAudioPeak(0.5, 0.004)).toBe('silent')
    expect(
      classifyOutputAudioPeak(0.01, 0.01 * AUDIO_PEAK_RETENTION_RATIO - 0.0001),
    ).toBe('silent')
  })
})

describe('blobForPlayback', () => {
  it('returns the same blob when mime matches or is omitted', () => {
    const blob = new Blob(['clip'], { type: 'video/mp4' })
    expect(blobForPlayback(blob)).toBe(blob)
    expect(blobForPlayback(blob, 'video/mp4')).toBe(blob)
    expect(blobForPlayback(blob, '  video/mp4  ')).toBe(blob)
  })

  it('retypes octet-stream and empty-type blobs with the clip mime', () => {
    const generic = new Blob(['clip'], { type: 'application/octet-stream' })
    const retyped = blobForPlayback(generic, 'video/mp4')
    expect(retyped).not.toBe(generic)
    expect(retyped.type).toBe('video/mp4')

    const empty = new Blob(['clip'])
    expect(blobForPlayback(empty, 'video/mp4').type).toBe('video/mp4')
  })

  it('prefers the clip mime when the blob type disagrees', () => {
    const mistyped = new Blob(['clip'], { type: 'video/webm' })
    const fixed = blobForPlayback(mistyped, 'video/mp4')
    expect(fixed.type).toBe('video/mp4')
  })
})

describe('audioDecodeFailureDetail', () => {
  it('includes mime and typed error identity for triage', () => {
    expect(audioDecodeFailureDetail(new DOMException('bad codec', 'EncodingError'), 'video/mp4')).toBe(
      ' (video/mp4; EncodingError: bad codec)',
    )
  })

  it('falls back when mime or message is empty', () => {
    expect(audioDecodeFailureDetail(new Error(''), '')).toBe(' (unknown-mime; unknown)')
    expect(audioDecodeFailureDetail('boom', 'audio/wav')).toBe(' (audio/wav; boom)')
  })

  it('caps oversized mime strings in both helper surfaces', () => {
    const huge = `video/${'a'.repeat(500)}`
    expect(boundedAudioMimeType(huge).length).toBe(120)
    const detail = audioDecodeFailureDetail(new Error('nope'), huge)
    expect(detail.length).toBeLessThan(280)
    expect(detail).toContain(boundedAudioMimeType(huge))
    expect(detail).not.toContain('a'.repeat(200))
  })
})

/** Tiny mono 16-bit PCM WAV used to exercise the mediabunny decode path. */
function makeWavBlob(amplitude = 0.5, durationSec = 0.25, freq = 440): Blob {
  const rate = 8000
  const samples = Math.round(durationSec * rate)
  const bytes = new DataView(new ArrayBuffer(44 + samples * 2))
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) bytes.setUint8(offset + i, text.charCodeAt(i))
  }
  writeAscii(0, 'RIFF')
  bytes.setUint32(4, 36 + samples * 2, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  bytes.setUint32(16, 16, true)
  bytes.setUint16(20, 1, true)
  bytes.setUint16(22, 1, true)
  bytes.setUint32(24, rate, true)
  bytes.setUint32(28, rate * 2, true)
  bytes.setUint16(32, 2, true)
  bytes.setUint16(34, 16, true)
  writeAscii(36, 'data')
  bytes.setUint32(40, samples * 2, true)
  for (let i = 0; i < samples; i += 1) {
    bytes.setInt16(
      44 + i * 2,
      Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amplitude * 32767),
      true,
    )
  }
  return new Blob([bytes.buffer], { type: 'audio/wav' })
}

describe('decodeBlobAudio', () => {
  it('decodes WAV and disposes the Input without leaking the track', async () => {
    const decoded = await decodeBlobAudio(makeWavBlob(), 48000)
    expect(decoded).not.toBeNull()
    expect(decoded!.sampleRate).toBe(48000)
    expect(decoded!.duration).toBeGreaterThan(0.2)
    // A second decode of the same bytes must still work after dispose().
    const again = await decodeBlobAudio(makeWavBlob(), 48000)
    expect(again).not.toBeNull()
  })

  it('fails fast on unrecognizable input without burning the retry budget', async () => {
    const started = performance.now()
    await expect(
      decodeBlobAudio(new Blob(['not media'], { type: 'video/webm' }), 48000),
    ).rejects.toThrow(/unsupported or unrecognizable/i)
    // Permanent format errors must not walk MEDIA_LOAD_RETRY_DELAYS_MS (~3.7s).
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe('isWebKitAudioDecoderNotFoundError', () => {
  it('matches WebKit NotFoundError DOMExceptions and Error.name', () => {
    expect(isWebKitAudioDecoderNotFoundError(new DOMException('The object can not be found here.', 'NotFoundError'))).toBe(
      true,
    )
    const named = new Error('The object can not be found here.')
    named.name = 'NotFoundError'
    expect(isWebKitAudioDecoderNotFoundError(named)).toBe(true)
    expect(isWebKitAudioDecoderNotFoundError(new Error('nope'))).toBe(false)
    expect(isWebKitAudioDecoderNotFoundError(new DOMException('bad', 'EncodingError'))).toBe(false)
  })
})

describe('resampleAudioBuffer', () => {
  it('preserves content when the rate already matches', () => {
    const source = new AudioBuffer({ length: 8, sampleRate: 48000, numberOfChannels: 1 })
    source.getChannelData(0).set([0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5])
    expect(resampleAudioBuffer(source, 48000)).toBe(source)
  })

  it('resamples to the target rate without OfflineAudioContext', () => {
    const source = new AudioBuffer({ length: 8, sampleRate: 8000, numberOfChannels: 1 })
    source.getChannelData(0).fill(0.25)
    const out = resampleAudioBuffer(source, 16000)
    expect(out.sampleRate).toBe(16000)
    expect(out.length).toBe(16)
    expect(out.getChannelData(0)[0]).toBeCloseTo(0.25, 5)
  })
})

describe('decodeBlobAudioViaWebAudio', () => {
  it('decodes a WAV through remux/decodeAudioData', async () => {
    const decoded = await decodeBlobAudioViaWebAudio(makeWavBlob(), 48000)
    expect(decoded).not.toBeNull()
    expect(decoded!.sampleRate).toBe(48000)
    expect(decoded!.duration).toBeGreaterThan(0.2)
    expect(decoded!.getChannelData(0).some((s) => Math.abs(s) > 0.1)).toBe(true)
  })

  it('decodes audio from a video container clip (KODY-VIDEO-R fallback)', async () => {
    const clip = await makeTestClipBlob(400, 440)
    const decoded = await decodeBlobAudioViaWebAudio(clip, 48000)
    expect(decoded).not.toBeNull()
    expect(decoded!.sampleRate).toBe(48000)
    expect(decoded!.duration).toBeGreaterThan(0.2)
    expect(decoded!.getChannelData(0).some((s) => Math.abs(s) > 0.05)).toBe(true)
  })

  it('returns null for garbage bytes', async () => {
    await expect(
      decodeBlobAudioViaWebAudio(new Blob(['not media'], { type: 'video/mp4' }), 48000),
    ).resolves.toBeNull()
  })
})

describe('decodeClipAudio', () => {
  it('records a decoded observation for audible clips', async () => {
    resetAudioDiagnostics()
    const decoded = await decodeClipAudio(makeWavBlob(), 48000)
    expect(decoded).not.toBeNull()
    expect(decoded!.getChannelData(0).some((s) => Math.abs(s) > 0.1)).toBe(true)
  })

  it('keeps the failure-report gate closed across a fallback-style reset', async () => {
    resetAudioDiagnostics()
    expect(__isAudioDecodeFailureReportArmedForTests()).toBe(true)
    await decodeClipAudio(new Blob(['not media'], { type: 'video/webm' }), 48000)
    expect(__isAudioDecodeFailureReportArmedForTests()).toBe(false)

    // WebCodecs → realtime fallback clears observations but must not re-arm
    // the gate (otherwise the same export double-reports to Sentry).
    resetAudioDiagnostics({ retainFailureReport: true })
    expect(__isAudioDecodeFailureReportArmedForTests()).toBe(false)
    await decodeClipAudio(new Blob(['not media'], { type: 'video/webm' }), 48000)
    expect(__isAudioDecodeFailureReportArmedForTests()).toBe(false)

    // A fresh export re-arms.
    resetAudioDiagnostics()
    expect(__isAudioDecodeFailureReportArmedForTests()).toBe(true)
  })
})

describe('waitForPreviewCanvas / resolveEncodeCanvas', () => {
  it('returns a connected preview canvas once it mounts', async () => {
    let preview: HTMLCanvasElement | null = null
    const pending = waitForPreviewCanvas(() => preview, 500)
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    preview = canvas
    await expect(pending).resolves.toBe(canvas)
    canvas.remove()
  })

  it('times out when the preview never connects', async () => {
    await expect(waitForPreviewCanvas(() => null, 80)).resolves.toBeNull()
  })

  it('prefers the connected preview canvas', async () => {
    const preview = document.createElement('canvas')
    document.body.appendChild(preview)
    const resolved = await resolveEncodeCanvas({
      getPreviewCanvas: () => preview,
      preferPreview: true,
      requireAttached: true,
      previewTimeoutMs: 200,
    })
    expect(resolved.kind).toBe('preview')
    expect(resolved.encodingIntoPreview).toBe(true)
    expect(resolved.canvas).toBe(preview)
    expect(resolved.canvas.isConnected).toBe(true)
    resolved.release()
    // Caller-owned preview must survive release (only attached-fallback hosts detach).
    expect(preview.isConnected).toBe(true)
    preview.remove()
  })

  it('attaches an on-DOM host when requireAttached and preview is missing', async () => {
    const resolved = await resolveEncodeCanvas({
      getPreviewCanvas: () => null,
      preferPreview: true,
      requireAttached: true,
      previewTimeoutMs: 80,
    })
    expect(resolved.kind).toBe('attached-fallback')
    expect(resolved.encodingIntoPreview).toBe(false)
    expect(resolved.canvas.isConnected).toBe(true)
    expect(document.body.contains(resolved.canvas)).toBe(true)
    resolved.release()
    expect(resolved.canvas.isConnected).toBe(false)
  })

  it('returns a detached canvas when attachment is not required', async () => {
    const resolved = await resolveEncodeCanvas({
      preferPreview: false,
      requireAttached: false,
    })
    expect(resolved.kind).toBe('detached')
    expect(resolved.canvas.isConnected).toBe(false)
    resolved.release()
  })
})

describe('export muted play helpers (KODY-VIDEO-W)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('detects autoplay NotAllowedError and ignores unrelated failures', () => {
    expect(
      isAutoplayBlockedError(
        new DOMException(
          'The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.',
          'NotAllowedError',
        ),
      ),
    ).toBe(true)
    expect(isAutoplayBlockedError(new DOMException('Permission denied', 'NotAllowedError'))).toBe(
      true,
    )
    expect(isAutoplayBlockedError(new DOMException('aborted', 'AbortError'))).toBe(false)
    expect(isAutoplayBlockedError(new Error('NotAllowedError'))).toBe(false)
  })

  it('sets Safari-load-bearing muted / playsinline attributes', () => {
    const video = document.createElement('video')
    prepareExportVideoElement(video)
    expect(video.muted).toBe(true)
    expect(video.defaultMuted).toBe(true)
    expect(video.playsInline).toBe(true)
    expect(video.getAttribute('muted')).toBe('')
    expect(video.getAttribute('playsinline')).toBe('true')
    expect(video.getAttribute('webkit-playsinline')).toBe('true')
  })

  it('playExportVideo returns playing when play() resolves', async () => {
    const video = document.createElement('video')
    const play = vi.spyOn(video, 'play').mockResolvedValue(undefined)
    await expect(playExportVideo(video)).resolves.toBe('playing')
    expect(play).toHaveBeenCalledTimes(1)
    expect(video.muted).toBe(true)
  })

  it('playExportVideo returns blocked on NotAllowedError instead of throwing', async () => {
    const video = document.createElement('video')
    vi.spyOn(video, 'play').mockRejectedValue(
      new DOMException(
        'The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.',
        'NotAllowedError',
      ),
    )
    await expect(playExportVideo(video)).resolves.toBe('blocked')
  })

  it('playExportVideo rethrows non-autoplay failures', async () => {
    const video = document.createElement('video')
    vi.spyOn(video, 'play').mockRejectedValue(new DOMException('aborted', 'AbortError'))
    await expect(playExportVideo(video)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('unlockExportMediaPlayback primes play/pause from a clip blob', async () => {
    const blob = await makeTestClipBlob(200)
    // Spy on the prototype only for this test — browser-mode files share a
    // page, so leave nothing restored late for sibling suites.
    const play = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockResolvedValue(undefined)
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    try {
      unlockExportMediaPlayback(blob)
      expect(play).toHaveBeenCalled()
      // Flush the play().then(pause) microtask.
      await Promise.resolve()
      await Promise.resolve()
      expect(pause).toHaveBeenCalled()
    } finally {
      play.mockRestore()
      pause.mockRestore()
    }
  })

  it('unlockExportMediaPlayback no-ops without a blob', () => {
    const create = vi.spyOn(document, 'createElement')
    unlockExportMediaPlayback(null)
    unlockExportMediaPlayback(undefined)
    unlockExportMediaPlayback(new Blob([]))
    // No media element is created when there is nothing to prime.
    expect(create).not.toHaveBeenCalled()
    create.mockRestore()
  })
})
