/**
 * End-to-end proof of the Safari silent-audio fix: real AAC (encoded by
 * ffmpeg as ADTS), unwrapped by stripAdtsFrames, muxed through mp4-muxer
 * with a SYNTHESIZED AudioSpecificConfig — exactly what normalizeAacChunk
 * does when Safari's AudioEncoder omits the decoder description — must
 * produce an MP4 whose esds carries the right DecoderSpecificInfo and whose
 * audio ffmpeg decodes at the expected loudness.
 *
 * ffmpeg cannot serve as the strict-decoder oracle here: it sniffs and
 * recovers from both ADTS-framed payloads and missing decoder configs
 * (verified empirically), which is exactly why iOS-only silence never shows
 * up in ffmpeg-based tooling — Apple's AudioToolbox decoder is strict.
 * Assertions are therefore structural where strictness matters.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ArrayBufferTarget, Muxer } from 'mp4-muxer'
import { aacAudioSpecificConfig, isAdtsFramed, stripAdtsFrames } from './aac'

const SAMPLE_RATE = 48000
const CHANNELS = 2
const FRAME_SAMPLES = 1024

function resolveFfmpeg(): string | null {
  for (const bin of ['/usr/bin/ffmpeg', 'ffmpeg']) {
    if (bin !== 'ffmpeg' && !existsSync(bin)) continue
    try {
      const demuxers = execFileSync(bin, ['-hide_banner', '-demuxers'], { encoding: 'utf8' })
      if (/\bmov,mp4/.test(demuxers)) return bin
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

/** Split an ADTS stream into per-frame raw AAC payloads. */
function adtsToRawFrames(data: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = []
  let offset = 0
  while (offset < data.length) {
    const frameLength =
      ((data[offset + 3]! & 0x03) << 11) | (data[offset + 4]! << 3) | (data[offset + 5]! >> 5)
    const frame = data.subarray(offset, offset + frameLength)
    const raw = stripAdtsFrames(frame)
    if (!raw) throw new Error(`Bad ADTS frame at offset ${offset}`)
    frames.push(raw)
    offset += frameLength
  }
  return frames
}

function muxAacFrames(frames: Uint8Array[], description: Uint8Array | undefined): Uint8Array {
  const target = new ArrayBufferTarget()
  const muxer = new Muxer({
    target,
    audio: { codec: 'aac', numberOfChannels: CHANNELS, sampleRate: SAMPLE_RATE },
    fastStart: false,
  })
  const frameUs = Math.round((FRAME_SAMPLES / SAMPLE_RATE) * 1_000_000)
  frames.forEach((frame, index) => {
    muxer.addAudioChunkRaw(
      frame,
      'key',
      index * frameUs,
      frameUs,
      index === 0
        ? {
            decoderConfig: {
              codec: 'mp4a.40.2',
              sampleRate: SAMPLE_RATE,
              numberOfChannels: CHANNELS,
              ...(description ? { description } : {}),
            },
          }
        : undefined,
    )
  })
  muxer.finalize()
  return new Uint8Array(target.buffer)
}

/** ffmpeg's measured mean volume in dB, or null when audio can't be decoded.
 * volumedetect prints its stats to stderr whether or not decoding succeeds. */
function meanVolumeDb(ffmpeg: string, file: string): number | null {
  const result = spawnSync(
    ffmpeg,
    ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8' },
  )
  const match = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(`${result.stdout}\n${result.stderr}`)
  return match ? Number(match[1]) : null
}

/**
 * The DecoderSpecificInfo bytes inside the file's esds box (tag 0x05).
 * Layout per mp4-muxer's writer: ES_Descriptor (0x03) → DecoderConfig
 * (0x04) → DecoderSpecificInfo (0x05, length, payload).
 */
function esdsDecoderSpecificInfo(file: Uint8Array): Uint8Array | null {
  const marker = [0x65, 0x73, 0x64, 0x73] // 'esds'
  // Scan backwards: moov (and its esds) trails the media data here, and the
  // compressed payload bytes can contain accidental 'esds' sequences.
  for (let i = file.length - 5; i >= 0; i -= 1) {
    if (marker.every((byte, j) => file[i + j] === byte)) {
      for (let k = i + 4; k < Math.min(i + 64, file.length - 1); k += 1) {
        if (file[k] === 0x05) {
          // Descriptor length is a base-128 varint (0x80 = continuation).
          let length = 0
          let cursor = k + 1
          for (;;) {
            const byte = file[cursor]!
            length = (length << 7) | (byte & 0x7f)
            cursor += 1
            if ((byte & 0x80) === 0) break
          }
          return file.subarray(cursor, cursor + length)
        }
      }
      return null
    }
  }
  return null
}

const ffmpeg = resolveFfmpeg()
const workDir = mkdtempSync(join(tmpdir(), 'kody-aac-mux-'))

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe.skipIf(!ffmpeg)('AAC mux with synthesized decoder config', () => {
  it('produces audible MP4 audio from ADTS input without an encoder description', () => {
    const adtsPath = join(workDir, 'tone.aac')
    execFileSync(ffmpeg!, [
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=1:sample_rate=${SAMPLE_RATE}`,
      '-ac',
      String(CHANNELS),
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-f',
      'adts',
      adtsPath,
    ])
    const adts = new Uint8Array(readFileSync(adtsPath))
    expect(isAdtsFramed(adts)).toBe(true)

    const frames = adtsToRawFrames(adts)
    expect(frames.length).toBeGreaterThan(20)

    // The fix: ADTS unwrapped + our synthesized AudioSpecificConfig.
    const fixed = muxAacFrames(frames, aacAudioSpecificConfig(SAMPLE_RATE, CHANNELS))
    const fixedPath = join(workDir, 'fixed.mp4')
    writeFileSync(fixedPath, fixed)
    expect([...(esdsDecoderSpecificInfo(fixed) ?? [])]).toEqual([0x11, 0x90])
    const fixedVolume = meanVolumeDb(ffmpeg!, fixedPath)
    expect(fixedVolume).not.toBe(null)
    // A sine at default lavfi level decodes well above any silence floor.
    expect(fixedVolume!).toBeGreaterThan(-30)

    // mp4-muxer 5.x guesses an AAC-LC config when the encoder omits the
    // description (older versions wrote a zero-length one) — our explicit
    // injection pins the same bytes rather than relying on the guess.
    const guessed = muxAacFrames(frames, undefined)
    expect([...(esdsDecoderSpecificInfo(guessed) ?? [])]).toEqual([0x11, 0x90])
  })
})
