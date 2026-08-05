import { beforeEach, describe, expect, it } from 'vitest'
import { ensureClipAudioPeak, measureClipAudioPeak } from './clip-audio-peak'
import { __resetDbForTests, addClip, createProject, getClip } from './storage'

/** Tiny mono 16-bit PCM WAV with a known amplitude. */
function makeWavBlob(amplitude: number, durationSec = 0.5, freq = 440): Blob {
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

describe('clip audio peak measurement', () => {
  beforeEach(async () => {
    await __resetDbForTests()
  })

  it('measures the whole-file peak of decodable audio', async () => {
    const peak = await measureClipAudioPeak(makeWavBlob(0.5))
    // Resampling to the export rate can nudge the peak slightly.
    expect(peak).toBeGreaterThan(0.4)
    expect(peak).toBeLessThan(0.6)
  })

  it('reports 0 for undecodable blobs (mixed unscaled, like the export)', async () => {
    expect(await measureClipAudioPeak(new Blob(['not media'], { type: 'video/webm' }))).toBe(0)
  })

  it('backfills and persists the measurement once', async () => {
    const project = await createProject('Peaks')
    const clip = await addClip({
      projectId: project.id,
      blob: makeWavBlob(0.5),
      mimeType: 'video/webm',
      durationMs: 500,
    })
    expect(clip.audioPeak).toBeUndefined()

    const measured = await ensureClipAudioPeak(clip)
    expect(measured.audioPeak).toBeGreaterThan(0.4)
    expect((await getClip(clip.id))?.audioPeak).toBe(measured.audioPeak)

    // Already-measured clips are returned as-is (no re-decode, no write).
    const again = await ensureClipAudioPeak({ ...measured, blob: new Blob(['junk']) })
    expect(again.audioPeak).toBe(measured.audioPeak)
  })
})
