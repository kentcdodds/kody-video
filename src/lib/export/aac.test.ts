import { describe, expect, it } from 'vitest'
import { aacAudioSpecificConfig, isAdtsFramed, stripAdtsFrames } from './aac'

function adtsFrame(payload: number[], { protectionAbsent = true } = {}): number[] {
  const headerLength = protectionAbsent ? 7 : 9
  const frameLength = headerLength + payload.length
  const header = [
    0xff,
    0xf0 | (protectionAbsent ? 0x01 : 0x00),
    0x50, // profile AAC-LC, freq index 3 (48k), start of channel config
    0x80 | ((frameLength >> 11) & 0x03),
    (frameLength >> 3) & 0xff,
    ((frameLength & 0x07) << 5) | 0x1f,
    0xfc,
  ]
  if (!protectionAbsent) header.push(0x00, 0x00)
  return [...header, ...payload]
}

describe('aacAudioSpecificConfig', () => {
  it('encodes 48kHz stereo AAC-LC (the export settings)', () => {
    expect([...aacAudioSpecificConfig(48000, 2)]).toEqual([0x11, 0x90])
  })

  it('encodes 44.1kHz stereo', () => {
    expect([...aacAudioSpecificConfig(44100, 2)]).toEqual([0x12, 0x10])
  })

  it('falls back to the 48kHz index for unknown rates', () => {
    expect([...aacAudioSpecificConfig(12345, 2)]).toEqual([0x11, 0x90])
  })
})

describe('ADTS handling', () => {
  it('detects ADTS sync words', () => {
    expect(isAdtsFramed(new Uint8Array(adtsFrame([1, 2, 3])))).toBe(true)
    expect(isAdtsFramed(new Uint8Array([0x21, 0x00, 0x03, 0x40, 0x68, 0x1c]))).toBe(false)
    expect(isAdtsFramed(new Uint8Array([0xff, 0xf1]))).toBe(false)
  })

  it('strips a single frame header (protection absent)', () => {
    const stripped = stripAdtsFrames(new Uint8Array(adtsFrame([9, 8, 7, 6])))
    expect(stripped && [...stripped]).toEqual([9, 8, 7, 6])
  })

  it('strips a header with CRC (protection present)', () => {
    const stripped = stripAdtsFrames(
      new Uint8Array(adtsFrame([5, 4, 3], { protectionAbsent: false })),
    )
    expect(stripped && [...stripped]).toEqual([5, 4, 3])
  })

  it('concatenates multiple frames', () => {
    const stripped = stripAdtsFrames(
      new Uint8Array([...adtsFrame([1, 2]), ...adtsFrame([3, 4, 5])]),
    )
    expect(stripped && [...stripped]).toEqual([1, 2, 3, 4, 5])
  })

  it('returns null for raw (non-ADTS) AAC so callers pass it through', () => {
    expect(stripAdtsFrames(new Uint8Array([0x21, 0x1b, 0x80, 0x00]))).toBe(null)
  })

  it('returns null for truncated frames', () => {
    const frame = adtsFrame([1, 2, 3, 4, 5, 6])
    expect(stripAdtsFrames(new Uint8Array(frame.slice(0, frame.length - 3)))).toBe(null)
  })
})
