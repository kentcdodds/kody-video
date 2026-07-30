/**
 * AAC bitstream helpers for the WebCodecs → mp4-muxer seam.
 *
 * Chrome's AudioEncoder emits raw AAC with `decoderConfig.description` (the
 * AudioSpecificConfig) on the first chunk. WebKit's has been observed to
 * omit the description and to emit ADTS-framed packets — ADTS inside MP4 is
 * something lenient decoders (ffmpeg) sniff and forgive but Apple's own
 * AudioToolbox plays back as SILENCE, with no error at any stage. These
 * helpers unwrap ADTS and pin an explicit AudioSpecificConfig rather than
 * relying on mp4-muxer's guessed default.
 */

const ADTS_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
]

/** Two-byte AudioSpecificConfig for AAC-LC (the profile encoders produce). */
export function aacAudioSpecificConfig(sampleRate: number, channels: number): Uint8Array {
  const audioObjectType = 2 // AAC-LC
  let frequencyIndex = ADTS_SAMPLE_RATES.indexOf(sampleRate)
  if (frequencyIndex < 0) frequencyIndex = 3 // 48000, our encoder setting
  // 5 bits object type · 4 bits frequency index · 4 bits channel config · 3 zero bits
  const bits = (audioObjectType << 11) | (frequencyIndex << 7) | (channels << 3)
  return new Uint8Array([(bits >> 8) & 0xff, bits & 0xff])
}

/** True when the payload starts with an ADTS sync word (0xFFF + MPEG-4/2 header). */
export function isAdtsFramed(data: Uint8Array): boolean {
  return data.length >= 7 && data[0] === 0xff && (data[1]! & 0xf6) === 0xf0
}

/**
 * Unwrap ADTS frames into raw AAC access units (concatenated). Returns null
 * when the data doesn't parse as ADTS — callers should pass the original
 * payload through untouched in that case.
 */
export function stripAdtsFrames(data: Uint8Array): Uint8Array | null {
  const payloads: Uint8Array[] = []
  let offset = 0
  while (offset < data.length) {
    if (data.length - offset < 7) return null
    if (data[offset] !== 0xff || (data[offset + 1]! & 0xf6) !== 0xf0) return null
    const protectionAbsent = (data[offset + 1]! & 0x01) === 1
    const headerLength = protectionAbsent ? 7 : 9
    const frameLength =
      ((data[offset + 3]! & 0x03) << 11) | (data[offset + 4]! << 3) | (data[offset + 5]! >> 5)
    if (frameLength < headerLength || offset + frameLength > data.length) return null
    payloads.push(data.subarray(offset + headerLength, offset + frameLength))
    offset += frameLength
  }
  if (payloads.length === 0) return null
  const total = payloads.reduce((sum, p) => sum + p.length, 0)
  const out = new Uint8Array(total)
  let position = 0
  for (const payload of payloads) {
    out.set(payload, position)
    position += payload.length
  }
  return out
}

export interface AacChunkDiagnostics {
  chunks: number
  describedByEncoder: boolean
  injectedDescription: boolean
  adtsStripped: number
  timestampOverrides: number
}

/** Samples per AAC access unit — fixed by the codec. */
export const AAC_FRAME_SAMPLES = 1024

/** Trust the encoder's timestamp only within this window of the derived
 * one. WebKit's AudioEncoder has been observed emitting several chunks all
 * timestamped 0 — a broken sample timeline that strict (Apple) players
 * render as silence while raw-stream decoders play it fine. */
const TIMESTAMP_TOLERANCE_US = 25_000

/**
 * The timestamp the chunk SHOULD have: audio is fed to the encoder as one
 * contiguous 48kHz timeline (segment offsets included), and every AAC chunk
 * is one 1024-sample access unit — so position in the sequence fully
 * determines timing. Prefers the encoder's own stamp when it agrees.
 */
export function deriveAacChunkTimestampUs(
  chunkIndex: number,
  encoderTimestampUs: number,
  sampleRate: number,
): { timestampUs: number; overridden: boolean } {
  const derivedUs = Math.round((chunkIndex * AAC_FRAME_SAMPLES * 1_000_000) / sampleRate)
  if (Math.abs(encoderTimestampUs - derivedUs) <= TIMESTAMP_TOLERANCE_US) {
    return { timestampUs: encoderTimestampUs, overridden: false }
  }
  return { timestampUs: derivedUs, overridden: true }
}

export interface NormalizedAacChunk {
  chunk: EncodedAudioChunk
  meta: EncodedAudioChunkMetadata | undefined
}

/**
 * Make an AudioEncoder output chunk safe for mp4-muxer: unwrap ADTS payloads
 * and guarantee the first chunk's metadata carries a decoder description.
 */
export function normalizeAacChunk(
  chunk: EncodedAudioChunk,
  meta: EncodedAudioChunkMetadata | undefined,
  options: { sampleRate: number; channels: number; diagnostics: AacChunkDiagnostics },
): NormalizedAacChunk {
  const { sampleRate, channels, diagnostics } = options
  const isFirstChunk = diagnostics.chunks === 0
  const chunkIndex = diagnostics.chunks
  diagnostics.chunks += 1

  let outChunk = chunk
  const data = new Uint8Array(chunk.byteLength)
  chunk.copyTo(data)
  const raw = isAdtsFramed(data) ? stripAdtsFrames(data) : null
  if (raw) diagnostics.adtsStripped += 1

  const timing = deriveAacChunkTimestampUs(chunkIndex, chunk.timestamp, sampleRate)
  if (timing.overridden) diagnostics.timestampOverrides += 1

  if (raw || timing.overridden) {
    outChunk = new EncodedAudioChunk({
      type: chunk.type,
      timestamp: timing.timestampUs,
      ...(typeof chunk.duration === 'number' ? { duration: chunk.duration } : {}),
      data: raw ?? data,
    })
  }

  let outMeta = meta
  const description = meta?.decoderConfig?.description
  if (description && description.byteLength > 0) {
    diagnostics.describedByEncoder = true
  } else if (isFirstChunk) {
    // Pin the config explicitly instead of leaving mp4-muxer to guess one
    // (5.x guesses correctly for AAC-LC; older versions wrote it empty).
    diagnostics.injectedDescription = true
    outMeta = {
      ...meta,
      decoderConfig: {
        codec: 'mp4a.40.2',
        sampleRate,
        numberOfChannels: channels,
        ...meta?.decoderConfig,
        description: aacAudioSpecificConfig(sampleRate, channels),
      },
    }
  }

  return { chunk: outChunk, meta: outMeta }
}
