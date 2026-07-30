import {
  ArrayBufferTarget as Mp4Target,
  Muxer as Mp4Muxer,
} from 'mp4-muxer'
import {
  ArrayBufferTarget as WebmTarget,
  Muxer as WebmMuxer,
} from 'webm-muxer'
import { deriveProjectLocation } from '../geo'
import type { ClipRecord } from '../types'
import { normalizeAacChunk, type AacChunkDiagnostics } from './aac'
import { injectMp4Metadata, type Mp4Chapter } from './mp4-metadata'
import { clampSegmentToMedia, type ExportPlan } from './plan'
import {
  PREVIEW_EVERY_N_FRAMES,
  blitPreview,
  decodeClipAudio,
  drawCover,
  drawWatermark,
  loadClipVideo,
  pickOutputSize,
  recordVideoLumaSample,
  seekTo,
  waitForPreviewCanvas,
  type ExportResult,
} from './shared'

const FPS = 30
const AUDIO_SAMPLE_RATE = 48000
const AUDIO_CHANNELS = 2
const AUDIO_CHUNK_FRAMES = 4800 // 100ms
const KEYFRAME_INTERVAL_US = 2_000_000
const VIDEO_BITRATE = 4_000_000
const AUDIO_BITRATE = 192_000

export function supportsWebCodecsExport(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined'
}

interface CodecChoice {
  container: 'mp4' | 'webm'
  videoCodec: string
  audioCodec: string
}

async function isVideoConfigSupported(config: VideoEncoderConfig): Promise<boolean> {
  try {
    const support = await VideoEncoder.isConfigSupported(config)
    return support.supported === true
  } catch {
    return false
  }
}

async function isAudioConfigSupported(config: AudioEncoderConfig): Promise<boolean> {
  if (typeof AudioEncoder === 'undefined') return false
  try {
    const support = await AudioEncoder.isConfigSupported(config)
    return support.supported === true
  } catch {
    return false
  }
}

function videoEncoderConfig(codec: string, width: number, height: number): VideoEncoderConfig {
  const config: VideoEncoderConfig = {
    codec,
    width,
    height,
    bitrate: VIDEO_BITRATE,
    framerate: FPS,
  }
  if (codec.startsWith('avc1')) {
    config.avc = { format: 'avc' }
  }
  return config
}

function audioEncoderConfig(codec: string): AudioEncoderConfig {
  return {
    codec,
    sampleRate: AUDIO_SAMPLE_RATE,
    numberOfChannels: AUDIO_CHANNELS,
    bitrate: AUDIO_BITRATE,
  }
}

/**
 * Prefer MP4 (H.264 + AAC) because Android share targets accept it
 * universally; fall back to WebM (VP9/VP8 + Opus). A working audio encoder
 * is required — clips carry mic audio, so a silent WebCodecs export would be
 * strictly worse than the realtime fallback engine, which can mix audio.
 */
async function pickCodecs(width: number, height: number): Promise<CodecChoice | null> {
  const avc = 'avc1.640028'
  const aac = 'mp4a.40.2'
  const opus = 'opus'

  if (
    (await isVideoConfigSupported(videoEncoderConfig(avc, width, height))) &&
    (await isAudioConfigSupported(audioEncoderConfig(aac)))
  ) {
    return { container: 'mp4', videoCodec: avc, audioCodec: aac }
  }
  if (await isAudioConfigSupported(audioEncoderConfig(opus))) {
    for (const vp of ['vp09.00.31.08', 'vp8']) {
      if (await isVideoConfigSupported(videoEncoderConfig(vp, width, height))) {
        return { container: 'webm', videoCodec: vp, audioCodec: opus }
      }
    }
  }
  return null
}

interface MuxerLike {
  addVideoChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void
  addAudioChunk(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata): void
  finalize(): void
}

/**
 * Frame-accurate export: each clip plays muted while its frames are captured
 * with requestVideoFrameCallback, normalized on a canvas, and encoded with
 * WebCodecs. Audio is decoded and encoded sample-accurately per segment, so
 * clips cannot drift against their soundtrack. Output timestamps come from
 * media time — a slow device slows the export down but cannot corrupt timing.
 */
export async function exportWithWebCodecs(
  plan: ExportPlan,
  onProgress?: (ratio: number) => void,
  getPreviewCanvas?: () => HTMLCanvasElement | null,
  watermarkImage?: HTMLImageElement | null,
): Promise<ExportResult> {
  if (!supportsWebCodecsExport()) {
    throw new Error('WebCodecs is not available')
  }

  // Probe the first clip for output dimensions.
  const probe = await loadClipVideo(plan.segments[0].clip.blob)
  const { width, height } = pickOutputSize(probe.video.videoWidth, probe.video.videoHeight)
  probe.release()

  const choice = await pickCodecs(width, height)
  if (!choice) {
    throw new Error('No supported export codec')
  }

  // Draw into the on-DOM overlay canvas when available: Safari-family
  // engines have a history of treating detached canvases as black (see the
  // realtime engine's captureStream fix) — and it doubles as a per-frame
  // live preview. Falls back to a detached canvas (fine on Chromium).
  let canvas = await waitForPreviewCanvas(getPreviewCanvas)
  const encodingIntoPreview = canvas !== null
  if (!canvas) {
    canvas = document.createElement('canvas')
  }
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Canvas not available')

  let muxer: MuxerLike
  let takeBuffer: () => ArrayBuffer
  const chapters: Mp4Chapter[] = []
  if (choice.container === 'mp4') {
    const target = new Mp4Target()
    const mp4 = new Mp4Muxer({
      target,
      video: { codec: 'avc', width, height },
      audio: { codec: 'aac', numberOfChannels: AUDIO_CHANNELS, sampleRate: AUDIO_SAMPLE_RATE },
      // Trailing moov so chapter/geotag injection can append udta without
      // rewriting stco/co64. Exports are saved/shared, not streamed, so
      // faststart matters little here.
      fastStart: false,
    })
    muxer = mp4
    takeBuffer = () => target.buffer
  } else {
    const target = new WebmTarget()
    const webm = new WebmMuxer({
      target,
      video: {
        codec: choice.videoCodec === 'vp8' ? 'V_VP8' : 'V_VP9',
        width,
        height,
        frameRate: FPS,
      },
      audio: { codec: 'A_OPUS', numberOfChannels: AUDIO_CHANNELS, sampleRate: AUDIO_SAMPLE_RATE },
    })
    muxer = webm
    takeBuffer = () => target.buffer
  }

  let encoderError: Error | null = null
  const failWith = (err: unknown) => {
    if (!encoderError) {
      encoderError = err instanceof Error ? err : new Error('Export encoder failed')
    }
  }

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        muxer.addVideoChunk(chunk, meta)
      } catch (err) {
        failWith(err)
      }
    },
    error: failWith,
  })
  videoEncoder.configure(videoEncoderConfig(choice.videoCodec, width, height))

  // WebKit's AudioEncoder can frame AAC packets as ADTS — undecodable
  // inside MP4 for Apple's own (strict) decoder, i.e. a silent audio track
  // with no error anywhere — and can omit the decoder description.
  // Normalize both before muxing.
  const aacDiagnostics: AacChunkDiagnostics = {
    chunks: 0,
    describedByEncoder: false,
    injectedDescription: false,
    adtsStripped: 0,
    timestampOverrides: 0,
  }
  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => {
      try {
        if (choice.container === 'mp4') {
          const fixed = normalizeAacChunk(chunk, meta, {
            sampleRate: AUDIO_SAMPLE_RATE,
            channels: AUDIO_CHANNELS,
            diagnostics: aacDiagnostics,
          })
          muxer.addAudioChunk(fixed.chunk, fixed.meta)
        } else {
          aacDiagnostics.chunks += 1
          muxer.addAudioChunk(chunk, meta)
        }
      } catch (err) {
        failWith(err)
      }
    },
    error: failWith,
  })
  audioEncoder.configure(audioEncoderConfig(choice.audioCodec))

  const state = {
    lastVideoTsUs: -1,
    lastKeyTsUs: -1_000_000_000,
    outputOffsetUs: 0,
    doneMs: 0,
    frameCount: 0,
  }

  const clipsInPlan = plan.segments.map((s) => s.clip)
  const multiDay = clipsSpanMultipleDays(clipsInPlan)

  try {
    for (const segment of plan.segments) {
      if (encoderError) throw encoderError

      const loaded = await loadClipVideo(segment.clip.blob)
      try {
        const clamped = clampSegmentToMedia(segment, loaded.mediaDurationMs)
        if (!clamped) continue
        const segmentMs = clamped.endMs - clamped.startMs

        if (choice.container === 'mp4') {
          chapters.push({
            startMs: Math.round(state.outputOffsetUs / 1000),
            title: formatChapterTitle(segment.clip, multiDay),
          })
        }

        const buffer = await decodeClipAudio(segment.clip.blob, AUDIO_SAMPLE_RATE)
        encodeSegmentAudio({
          audioEncoder,
          buffer,
          startMs: clamped.startMs,
          segmentMs,
          outputOffsetUs: state.outputOffsetUs,
        })
        if (encoderError) throw encoderError

        await pumpSegmentVideo({
          video: loaded.video,
          startSec: clamped.startMs / 1000,
          endSec: clamped.endMs / 1000,
          canvas,
          ctx,
          videoEncoder,
          state,
          // No mirroring needed when the encode canvas is the preview.
          getPreviewCanvas: encodingIntoPreview ? undefined : getPreviewCanvas,
          watermarkImage,
          hasError: () => encoderError !== null,
          onElapsedMs: (elapsed) => {
            if (plan.totalMs > 0) {
              onProgress?.(Math.min(1, (state.doneMs + elapsed) / plan.totalMs))
            }
          },
        })
        if (encoderError) throw encoderError

        state.outputOffsetUs += Math.round(segmentMs * 1000)
        state.doneMs += segmentMs
        onProgress?.(plan.totalMs > 0 ? Math.min(1, state.doneMs / plan.totalMs) : 1)
      } finally {
        loaded.release()
      }
    }

    if (state.lastVideoTsUs < 0) {
      throw new Error('No video frames could be exported')
    }

    await videoEncoder.flush()
    await audioEncoder.flush()
    if (encoderError) throw encoderError
    muxer.finalize()
  } finally {
    try {
      if (videoEncoder.state !== 'closed') videoEncoder.close()
    } catch {
      // already closed
    }
    try {
      if (audioEncoder.state !== 'closed') audioEncoder.close()
    } catch {
      // already closed
    }
  }

  onProgress?.(1)
  let buffer = takeBuffer()
  if (choice.container === 'mp4') {
    buffer = injectMp4Metadata(buffer, {
      chapters,
      location: deriveProjectLocation(clipsInPlan),
    })
  }
  const mimeType = choice.container === 'mp4' ? 'video/mp4' : 'video/webm'
  return {
    blob: new Blob([buffer], { type: mimeType }),
    mimeType,
    fileExtension: choice.container,
    audioDiagnostics: {
      audioChunks: aacDiagnostics.chunks,
      describedByEncoder: aacDiagnostics.describedByEncoder,
      injectedDescription: aacDiagnostics.injectedDescription,
      adtsStripped: aacDiagnostics.adtsStripped,
      timestampOverrides: aacDiagnostics.timestampOverrides,
    },
  }
}

/** Recording start ≈ createdAt − durationMs (wall-clock capture window). */
function clipRecordingStartMs(clip: Pick<ClipRecord, 'createdAt' | 'durationMs'>): number {
  return clip.createdAt - clip.durationMs
}

function clipsSpanMultipleDays(clips: Pick<ClipRecord, 'createdAt' | 'durationMs'>[]): boolean {
  if (clips.length <= 1) return false
  const days = new Set<string>()
  for (const clip of clips) {
    const d = new Date(clipRecordingStartMs(clip))
    days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`)
    if (days.size > 1) return true
  }
  return false
}

function formatChapterTitle(
  clip: Pick<ClipRecord, 'createdAt' | 'durationMs' | 'lat' | 'lng'>,
  includeDate: boolean,
): string {
  const start = new Date(clipRecordingStartMs(clip))
  const time = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const datePrefix = includeDate
    ? `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })} `
    : ''
  let title = `${datePrefix}${time}`
  if (typeof clip.lat === 'number' && typeof clip.lng === 'number') {
    title += ` · ${clip.lat.toFixed(4)},${clip.lng.toFixed(4)}`
  }
  return title
}

interface PumpArgs {
  video: HTMLVideoElement
  startSec: number
  endSec: number
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  videoEncoder: VideoEncoder
  state: {
    lastVideoTsUs: number
    lastKeyTsUs: number
    outputOffsetUs: number
    frameCount: number
  }
  getPreviewCanvas?: () => HTMLCanvasElement | null
  watermarkImage?: HTMLImageElement | null
  hasError: () => boolean
  onElapsedMs: (elapsedMs: number) => void
}

async function pumpSegmentVideo({
  video,
  startSec,
  endSec,
  canvas,
  ctx,
  videoEncoder,
  state,
  getPreviewCanvas,
  watermarkImage,
  hasError,
  onElapsedMs,
}: PumpArgs): Promise<void> {
  await seekTo(video, startSec)

  const encodeFrameAt = (mediaTimeSec: number) => {
    const clampedSec = Math.min(Math.max(mediaTimeSec, startSec), endSec)
    let tsUs = state.outputOffsetUs + Math.round((clampedSec - startSec) * 1_000_000)
    if (tsUs <= state.lastVideoTsUs) {
      tsUs = state.lastVideoTsUs + 1000
    }
    drawCover(ctx, video, canvas.width, canvas.height)
    if (watermarkImage) {
      drawWatermark(ctx, watermarkImage, canvas.width, canvas.height)
    }
    const frame = new VideoFrame(canvas, {
      timestamp: tsUs,
      duration: Math.round(1_000_000 / FPS),
    })
    const keyFrame = tsUs - state.lastKeyTsUs >= KEYFRAME_INTERVAL_US
    try {
      videoEncoder.encode(frame, { keyFrame })
    } finally {
      frame.close()
    }
    if (keyFrame) state.lastKeyTsUs = tsUs
    state.lastVideoTsUs = tsUs
    if (state.frameCount % PREVIEW_EVERY_N_FRAMES === 0) {
      blitPreview(canvas, getPreviewCanvas?.())
    }
    if (state.frameCount % 30 === 0) {
      recordVideoLumaSample(canvas)
    }
    state.frameCount += 1
  }

  // Guarantee at least one frame per segment, even if playback ends instantly.
  encodeFrameAt(startSec)

  const supportsRvfc = typeof video.requestVideoFrameCallback === 'function'

  await video.play()

  try {
    await new Promise<void>((resolve, reject) => {
      let finished = false
      let lastProgressAt = performance.now()
      let lastMediaTime = startSec
      let rafId = 0
      let watchdogId = 0

      const finish = () => {
        if (finished) return
        finished = true
        window.clearInterval(watchdogId)
        if (rafId) cancelAnimationFrame(rafId)
        video.pause()
        resolve()
      }
      const abort = (err: Error) => {
        if (finished) return
        finished = true
        window.clearInterval(watchdogId)
        if (rafId) cancelAnimationFrame(rafId)
        video.pause()
        reject(err)
      }

      const handleFrame = (mediaTimeSec: number) => {
        if (finished) return
        if (hasError()) {
          abort(new Error('Export encoder failed'))
          return
        }
        if (mediaTimeSec > lastMediaTime + 0.001) {
          lastMediaTime = mediaTimeSec
          lastProgressAt = performance.now()
        }
        if (video.ended || mediaTimeSec >= endSec - 0.005) {
          finish()
          return
        }
        if (mediaTimeSec > startSec) {
          encodeFrameAt(mediaTimeSec)
          onElapsedMs((mediaTimeSec - startSec) * 1000)
        }

        // Backpressure: pause the source while the encoder catches up so slow
        // devices never drop frames from the output.
        if (videoEncoder.encodeQueueSize > 8) {
          video.pause()
          const waitDrain = () => {
            if (finished) return
            // Draining the encoder queue is progress: keep the stall watchdog
            // fed even when the paused video's media time isn't advancing.
            lastProgressAt = performance.now()
            if (videoEncoder.encodeQueueSize <= 2) {
              void video.play().catch(() => abort(new Error('Clip playback failed during export')))
              scheduleNext()
              return
            }
            window.setTimeout(waitDrain, 40)
          }
          waitDrain()
          return
        }
        scheduleNext()
      }

      const scheduleNext = () => {
        if (finished) return
        if (supportsRvfc) {
          video.requestVideoFrameCallback((_now, metadata) => {
            handleFrame(metadata.mediaTime)
          })
        } else {
          rafId = requestAnimationFrame(() => {
            handleFrame(video.currentTime)
          })
        }
      }

      video.onended = finish
      video.onerror = () => abort(new Error('A clip failed to play during export'))
      watchdogId = window.setInterval(() => {
        if (performance.now() - lastProgressAt > 10_000) {
          abort(new Error('Clip playback stalled during export'))
        }
      }, 1000)
      scheduleNext()
    })
  } finally {
    video.onended = null
    video.onerror = null
  }
}

interface SegmentAudioArgs {
  audioEncoder: AudioEncoder
  buffer: AudioBuffer | null
  startMs: number
  segmentMs: number
  outputOffsetUs: number
}

/**
 * Encode exactly `segmentMs` of audio for a segment: the decoded clip audio
 * sliced at the trim-in point, padded with silence where the clip has less
 * audio than video. Timestamps are derived, so segments can never drift.
 */
function encodeSegmentAudio({
  audioEncoder,
  buffer,
  startMs,
  segmentMs,
  outputOffsetUs,
}: SegmentAudioArgs): void {
  const totalFrames = Math.round((segmentMs / 1000) * AUDIO_SAMPLE_RATE)
  if (totalFrames <= 0) return

  const sourceRate = buffer?.sampleRate ?? AUDIO_SAMPLE_RATE
  const sourceStartFrame = buffer ? Math.floor((startMs / 1000) * sourceRate) : 0
  const channel0 = buffer?.getChannelData(0) ?? null
  const channel1 = buffer && buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : channel0

  let written = 0
  while (written < totalFrames) {
    const frames = Math.min(AUDIO_CHUNK_FRAMES, totalFrames - written)
    const data = new Float32Array(frames * AUDIO_CHANNELS)
    if (channel0 && channel1) {
      for (let i = 0; i < frames; i += 1) {
        const src = sourceStartFrame + written + i
        if (src >= channel0.length) break
        data[i] = channel0[src]
        data[frames + i] = channel1[src]
      }
    }
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: AUDIO_SAMPLE_RATE,
      numberOfFrames: frames,
      numberOfChannels: AUDIO_CHANNELS,
      timestamp: outputOffsetUs + Math.round((written / AUDIO_SAMPLE_RATE) * 1_000_000),
      data,
    })
    try {
      audioEncoder.encode(audioData)
    } finally {
      audioData.close()
    }
    written += frames
  }
}
