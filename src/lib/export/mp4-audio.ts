/**
 * Fallback audio decoder for fragmented MP4 clips.
 *
 * Safari's MediaRecorder writes fragmented MP4, and WebKit's
 * `decodeAudioData` throws `EncodingError` on fragmented files — which made
 * every iOS export silent (the encoder happily wrote zeros). This module
 * demuxes the AAC track with mp4box.js and decodes it with WebCodecs
 * `AudioDecoder`, returning the same `AudioBuffer` shape `decodeAudioData`
 * would have produced. Loaded dynamically so Chrome/WebM projects never pay
 * for it.
 */

interface Mp4AudioTrackInfo {
  id: number
  codec: string
  audio?: { sample_rate?: number; channel_count?: number }
}

interface Mp4Sample {
  data: Uint8Array
  cts: number
  timescale: number
  duration: number
}

export async function decodeMp4AudioWithWebCodecs(
  blob: Blob,
  targetSampleRate: number,
): Promise<AudioBuffer | null> {
  if (typeof AudioDecoder === 'undefined') return null

  const { samples, track, description } = await demuxAudio(blob)
  if (!track || samples.length === 0) return null

  const decoded: AudioData[] = []
  let decodeError: unknown = null
  const decoder = new AudioDecoder({
    output: (data) => decoded.push(data),
    error: (err) => {
      decodeError = err
    },
  })
  try {
    decoder.configure({
      codec: track.codec,
      sampleRate: track.audio?.sample_rate ?? targetSampleRate,
      numberOfChannels: track.audio?.channel_count ?? 2,
      ...(description ? { description } : {}),
    })
    for (const sample of samples) {
      decoder.decode(
        new EncodedAudioChunk({
          type: 'key',
          timestamp: Math.round((sample.cts / sample.timescale) * 1_000_000),
          duration: Math.round((sample.duration / sample.timescale) * 1_000_000),
          data: sample.data,
        }),
      )
    }
    await decoder.flush()
  } catch (err) {
    decodeError = decodeError ?? err
  } finally {
    try {
      if (decoder.state !== 'closed') decoder.close()
    } catch {
      // already closed
    }
  }
  if (decodeError || decoded.length === 0) {
    decoded.forEach((d) => d.close())
    return null
  }

  try {
    const assembled = assembleAudioBuffer(decoded)
    if (!assembled) return null
    if (assembled.sampleRate === targetSampleRate) return assembled
    return await resample(assembled, targetSampleRate)
  } finally {
    decoded.forEach((d) => {
      try {
        d.close()
      } catch {
        // copyTo may have detached it already
      }
    })
  }
}

async function demuxAudio(blob: Blob): Promise<{
  samples: Mp4Sample[]
  track: Mp4AudioTrackInfo | null
  description: Uint8Array | null
}> {
  const MP4Box = await import('mp4box')
  const buffer = (await blob.arrayBuffer()) as ArrayBuffer & { fileStart: number }
  buffer.fileStart = 0

  return new Promise((resolve) => {
    const file = MP4Box.createFile()
    const samples: Mp4Sample[] = []
    let track: Mp4AudioTrackInfo | null = null
    let description: Uint8Array | null = null
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve({ samples, track, description })
    }
    // Malformed files can produce neither onReady nor onError.
    const timeout = setTimeout(finish, 10_000)

    file.onError = () => {
      clearTimeout(timeout)
      finish()
    }
    file.onReady = (info: { audioTracks?: Mp4AudioTrackInfo[] }) => {
      track = info.audioTracks?.[0] ?? null
      if (!track) {
        clearTimeout(timeout)
        finish()
        return
      }
      description = extractAudioSpecificConfig(file, track.id)
      file.setExtractionOptions(track.id, null, { nbSamples: Number.MAX_SAFE_INTEGER })
      file.start()
      // All bytes are already appended; flush drives extraction to the end.
      file.flush()
      clearTimeout(timeout)
      // onSamples fires synchronously during flush; resolve on next tick.
      setTimeout(finish, 0)
    }
    file.onSamples = (
      _id: number,
      _user: unknown,
      chunk: Array<{ data?: Uint8Array; cts: number; timescale: number; duration: number }>,
    ) => {
      for (const sample of chunk) {
        if (sample.data) {
          samples.push({
            data: sample.data,
            cts: sample.cts,
            timescale: sample.timescale,
            duration: sample.duration,
          })
        }
      }
    }
    file.appendBuffer(buffer)
    file.flush()
  })
}

/** AAC's AudioSpecificConfig lives in stsd → esds; AudioDecoder needs it. */
function extractAudioSpecificConfig(
  file: { getTrackById(id: number): unknown },
  trackId: number,
): Uint8Array | null {
  try {
    const trak = file.getTrackById(trackId) as {
      mdia?: {
        minf?: {
          stbl?: { stsd?: { entries?: Array<{ esds?: { esd?: unknown } }> } }
        }
      }
    }
    const entries = trak?.mdia?.minf?.stbl?.stsd?.entries ?? []
    for (const entry of entries) {
      const esd = entry.esds?.esd as
        | { descs?: Array<{ descs?: Array<{ data?: Uint8Array }> }> }
        | undefined
      const data = esd?.descs?.[0]?.descs?.[0]?.data
      if (data instanceof Uint8Array && data.length > 0) return data
    }
  } catch {
    // Fall through — AudioDecoder.configure will reject without it.
  }
  return null
}

function assembleAudioBuffer(decoded: AudioData[]): AudioBuffer | null {
  const first = decoded[0]
  const sampleRate = first.sampleRate
  const channels = Math.max(1, first.numberOfChannels)
  const totalFrames = decoded.reduce((sum, d) => sum + d.numberOfFrames, 0)
  if (totalFrames === 0) return null

  const buffer = new AudioBuffer({ length: totalFrames, numberOfChannels: channels, sampleRate })
  let offset = 0
  for (const data of decoded) {
    for (let ch = 0; ch < channels; ch += 1) {
      const target = new Float32Array(data.numberOfFrames)
      try {
        data.copyTo(target, { planeIndex: ch, format: 'f32-planar' })
      } catch {
        // Mono data asked for a second channel, or an unconvertible format:
        // duplicate channel 0 (already copied) or bail to silence for this ch.
        if (ch > 0) {
          buffer.copyToChannel(buffer.getChannelData(0).subarray(offset, offset + data.numberOfFrames), ch, offset)
          continue
        }
        return null
      }
      buffer.copyToChannel(target, ch, offset)
    }
    offset += data.numberOfFrames
  }
  return buffer
}

async function resample(buffer: AudioBuffer, targetSampleRate: number): Promise<AudioBuffer> {
  const length = Math.ceil(buffer.duration * targetSampleRate)
  const ctx = new OfflineAudioContext(buffer.numberOfChannels, Math.max(1, length), targetSampleRate)
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(ctx.destination)
  source.start()
  return ctx.startRendering()
}
