import { describe, expect, it } from 'vitest'
import {
  AUDIO_PEAK_RETENTION_RATIO,
  AUDIO_SILENCE_PEAK,
  blobForPlayback,
  classifyOutputAudioPeak,
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
