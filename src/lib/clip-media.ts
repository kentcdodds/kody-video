import { measureBlobDuration } from './media'
import { MIN_SLICE_MS } from './clip-edit'

export interface SlicedClipMedia {
  blob: Blob
  mimeType: string
  durationMs: number
  width?: number
  height?: number
}

/**
 * Re-mux (or transcode) a time range of a video blob into a new file.
 * Used to permanently drop unused trim and to split a clip into two files.
 */
export async function sliceClipMedia(
  blob: Blob,
  startMs: number,
  endMs: number,
): Promise<SlicedClipMedia> {
  const start = Math.max(0, startMs)
  const end = Math.max(start + MIN_SLICE_MS, endMs)
  if (!(end - start >= MIN_SLICE_MS)) {
    throw new Error('That slice is too short')
  }

  const { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, WebMOutputFormat } =
    await import('mediabunny')

  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const preferMp4 = (blob.type || '').toLowerCase().includes('mp4')
    const target = new BufferTarget()
    const mimeType = preferMp4 ? 'video/mp4' : 'video/webm'
    const output = new Output({
      format: preferMp4 ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
      target,
    })
    const size = await probeSlicedSize(input).catch(() => ({}))
    const conversion = await Conversion.init({
      input,
      output,
      trim: { start: start / 1000, end: end / 1000 },
      showWarnings: false,
    })
    if (!conversion.isValid) {
      throw new Error('Could not cut that clip on this device')
    }
    await conversion.execute()
    if (!target.buffer || target.buffer.byteLength <= 0) {
      throw new Error('Cutting the clip produced no video')
    }

    const sliced = new Blob([target.buffer], { type: mimeType })
    const durationMs = await measureSlicedDuration(sliced, end - start)
    return { blob: sliced, mimeType, durationMs, ...size }
  } finally {
    input.dispose()
  }
}

async function measureSlicedDuration(blob: Blob, fallbackMs: number): Promise<number> {
  try {
    const measured = await measureBlobDuration(blob)
    if (Number.isFinite(measured) && measured >= MIN_SLICE_MS) return measured
  } catch {
    // Fall through to the requested window.
  }
  return Math.round(fallbackMs)
}

async function probeSlicedSize(
  input: { getPrimaryVideoTrack: () => Promise<{ displayWidth: number; displayHeight: number; codedWidth: number; codedHeight: number } | null> },
): Promise<{ width?: number; height?: number }> {
  const track = await input.getPrimaryVideoTrack().catch(() => null)
  if (!track) return {}
  const width = track.displayWidth > 0 ? track.displayWidth : track.codedWidth
  const height = track.displayHeight > 0 ? track.displayHeight : track.codedHeight
  if (!(width > 0) || !(height > 0)) return {}
  return { width, height }
}
