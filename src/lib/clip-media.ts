import { measureBlobDuration } from './media'
import { MIN_SLICE_MS } from './clip-edit'

export interface SlicedClipMedia {
  blob: Blob
  mimeType: string
  durationMs: number
  width?: number
  height?: number
}

/** MP4-family sources (phone camera-roll .mov / .m4v included) must stay
 * MP4 — Safari often cannot encode those bitstreams into WebM. */
export function outputMimeForClipMedia(mimeType: string): 'video/mp4' | 'video/webm' {
  const lower = mimeType.toLowerCase()
  if (
    lower.includes('mp4') ||
    lower.includes('quicktime') ||
    lower.includes('m4v') ||
    lower.includes('x-m4v')
  ) {
    return 'video/mp4'
  }
  return 'video/webm'
}

/**
 * Re-mux (or transcode) a time range of a video blob into a new file.
 * Used to permanently drop unused trim and to split a clip into two files.
 */
export async function sliceClipMedia(
  blob: Blob,
  startMs: number,
  endMs: number,
  mimeHint?: string,
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
    const mimeType = outputMimeForClipMedia(blob.type || mimeHint || '')
    const preferMp4 = mimeType === 'video/mp4'
    const target = new BufferTarget()
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

/** Re-encode a clip at a smaller size/bitrate. Always transcodes. */
export async function reduceClipMedia(
  blob: Blob,
  target: { width: number; height: number; bitrate: number },
  mimeHint?: string,
): Promise<SlicedClipMedia> {
  const { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, Quality, WebMOutputFormat } =
    await import('mediabunny')

  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const mimeType = outputMimeForClipMedia(blob.type || mimeHint || '')
    const preferMp4 = mimeType === 'video/mp4'
    const dest = new BufferTarget()
    const output = new Output({
      format: preferMp4 ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
      target: dest,
    })
    const conversion = await Conversion.init({
      input,
      output,
      video: {
        width: target.width,
        height: target.height,
        fit: 'contain',
        quality: new Quality({ bitrate: target.bitrate }),
        forceTranscode: true,
      },
      showWarnings: false,
    })
    if (!conversion.isValid) {
      throw new Error('Could not reduce that clip on this device')
    }
    await conversion.execute()
    if (!dest.buffer || dest.buffer.byteLength <= 0) {
      throw new Error('Reducing the clip produced no video')
    }

    const reduced = new Blob([dest.buffer], { type: mimeType })
    const durationMs = await measureSlicedDuration(reduced, 0)
    return {
      blob: reduced,
      mimeType,
      durationMs: durationMs > 0 ? durationMs : 0,
      width: target.width,
      height: target.height,
    }
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

export interface VideoDisplaySize {
  width: number
  height: number
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

/** Container display size, including rotation / display matrices.
 * Does not consult `<video>` — on phones videoWidth/videoHeight can
 * follow the current hold and swap a landscape file to 9:16. */
export async function probeVideoFileSize(blob: Blob): Promise<VideoDisplaySize | null> {
  try {
    const { ALL_FORMATS, BlobSource, Input } = await import('mediabunny')
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
    try {
      const size = await probeSlicedSize(input)
      if (size.width && size.height) return { width: size.width, height: size.height }
    } finally {
      input.dispose()
    }
  } catch {
    // Unparseable container — caller may try the element path.
  }
  return null
}

export async function probeVideoElementSize(blob: Blob): Promise<VideoDisplaySize | null> {
  try {
    const { loadClipVideo } = await import('./export/shared')
    const loaded = await loadClipVideo(blob)
    try {
      const width = loaded.video.videoWidth
      const height = loaded.video.videoHeight
      if (width > 0 && height > 0) return { width, height }
    } finally {
      loaded.release()
    }
  } catch {
    return null
  }
  return null
}

/**
 * Pixel size the file actually displays, including rotation / display
 * matrices. Camera `getSettings()` often stays at the sensor size from
 * when the session started, so a sideways take can be stored as 9:16
 * even when the encoded frames are 16:9.
 */
export async function probeVideoDisplaySize(blob: Blob): Promise<VideoDisplaySize | null> {
  return (await probeVideoFileSize(blob)) ?? (await probeVideoElementSize(blob))
}
