import { describe, expect, it } from 'vitest'
import {
  __isAudioDecodeFailureReportArmedForTests,
  AUDIO_PEAK_RETENTION_RATIO,
  AUDIO_SILENCE_PEAK,
  audioDecodeFailureDetail,
  blobForPlayback,
  boundedAudioMimeType,
  classifyOutputAudioPeak,
  decodeBlobAudio,
  decodeClipAudio,
  resetAudioDiagnostics,
  resolveEncodeCanvas,
  waitForPreviewCanvas,
} from './shared'

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
