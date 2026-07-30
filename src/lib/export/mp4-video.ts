/**
 * MP4 video demuxer for the decode-driven export pump.
 *
 * The export's frame supply used to be a playing <video> element captured
 * via requestVideoFrameCallback — inherently paced at 1× playback (a 30min
 * project took 30min to export on ANY hardware) and dead in background tabs
 * (no compositing → no frames → stall watchdog → restart). Demuxing samples
 * with mp4box and decoding with WebCodecs VideoDecoder unties the export
 * from playback and the compositor entirely.
 */

interface Mp4VideoTrackInfo {
  id: number
  codec: string
  video?: { width?: number; height?: number }
  track_width?: number
  track_height?: number
  timescale?: number
  duration?: number
  movie_duration?: number
  movie_timescale?: number
}

export interface DemuxedVideoSample {
  data: Uint8Array
  /** Presentation timestamp in microseconds (composition time). */
  ptsUs: number
  durationUs: number
  isSync: boolean
}

export interface DemuxedVideo {
  /** WebCodecs codec string, e.g. 'avc1.640028' / 'hvc1.1.6.L120'. */
  codec: string
  codedWidth: number
  codedHeight: number
  /** avcC/hvcC decoder configuration payload, when the track carries one. */
  description: Uint8Array | null
  /** In DECODE order (as mp4box extracts them) — with B-frames this is NOT
   * presentation order, and the decoder must be fed exactly this order.
   * Presentation filtering happens on decoder OUTPUT frames instead. */
  samples: DemuxedVideoSample[]
  durationMs: number
}

export async function demuxMp4Video(blob: Blob): Promise<DemuxedVideo | null> {
  const MP4Box = await import('mp4box')
  const buffer = (await blob.arrayBuffer()) as ArrayBuffer & { fileStart: number }
  buffer.fileStart = 0

  return new Promise((resolve) => {
    const file = MP4Box.createFile()
    const samples: DemuxedVideoSample[] = []
    let track: Mp4VideoTrackInfo | null = null
    let description: Uint8Array | null = null
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      if (!track || samples.length === 0) {
        resolve(null)
        return
      }
      // Keep decode order for feeding; duration is the max presentation end.
      let endUs = 0
      for (const sample of samples) {
        const sampleEnd = sample.ptsUs + sample.durationUs
        if (sampleEnd > endUs) endUs = sampleEnd
      }
      resolve({
        codec: track.codec,
        codedWidth: track.video?.width ?? track.track_width ?? 0,
        codedHeight: track.video?.height ?? track.track_height ?? 0,
        description,
        samples,
        durationMs: Math.round(endUs / 1000),
      })
    }
    // Malformed files can produce neither onReady nor onError.
    const timeout = setTimeout(finish, 15_000)

    file.onError = () => {
      clearTimeout(timeout)
      finish()
    }
    file.onReady = (info: { videoTracks?: Mp4VideoTrackInfo[] }) => {
      track = info.videoTracks?.[0] ?? null
      if (!track) {
        clearTimeout(timeout)
        finish()
        return
      }
      description = extractDecoderDescription(MP4Box, file, track.id)
      file.setExtractionOptions(track.id, null, { nbSamples: Number.MAX_SAFE_INTEGER })
      file.start()
      file.flush()
      clearTimeout(timeout)
      // onSamples fires synchronously during flush; resolve on next tick.
      setTimeout(finish, 0)
    }
    file.onSamples = (
      _id: number,
      _user: unknown,
      chunk: Array<{
        data?: Uint8Array
        cts: number
        timescale: number
        duration: number
        is_sync?: boolean
      }>,
    ) => {
      for (const sample of chunk) {
        if (!sample.data) continue
        samples.push({
          data: sample.data,
          ptsUs: Math.round((sample.cts / sample.timescale) * 1_000_000),
          durationUs: Math.round((sample.duration / sample.timescale) * 1_000_000),
          isSync: sample.is_sync === true,
        })
      }
    }
    file.appendBuffer(buffer)
    file.flush()
  })
}

/**
 * The avcC/hvcC/vpcC box payload (minus the 8-byte box header) is exactly
 * the `description` VideoDecoder wants for AVCC/HVCC-framed samples.
 */
function extractDecoderDescription(
  MP4Box: typeof import('mp4box'),
  file: { getTrackById(id: number): unknown },
  trackId: number,
): Uint8Array | null {
  try {
    const trak = file.getTrackById(trackId) as {
      mdia?: {
        minf?: {
          stbl?: {
            stsd?: {
              entries?: Array<{
                avcC?: { write(stream: unknown): void }
                hvcC?: { write(stream: unknown): void }
                vpcC?: { write(stream: unknown): void }
              }>
            }
          }
        }
      }
    }
    const entries = trak?.mdia?.minf?.stbl?.stsd?.entries ?? []
    for (const entry of entries) {
      const box = entry.avcC ?? entry.hvcC ?? entry.vpcC
      if (!box) continue
      // DataStream defaults to big-endian, which is what box writing needs.
      const stream = new MP4Box.DataStream(undefined, 0)
      box.write(stream)
      // Skip the 8-byte box header (size + fourcc).
      return new Uint8Array(stream.buffer as ArrayBuffer, 8)
    }
  } catch {
    // Fall through — the caller falls back to the element pump.
  }
  return null
}
