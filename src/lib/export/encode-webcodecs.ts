import {
  ArrayBufferTarget as Mp4Target,
  Muxer as Mp4Muxer,
} from 'mp4-muxer'
import {
  ArrayBufferTarget as WebmTarget,
  Muxer as WebmMuxer,
} from 'webm-muxer'
import { deriveProjectLocation } from '../geo'
import { isIosBrowser } from '../media'
import type { ClipRecord } from '../types'
import { normalizeAacChunk, type AacChunkDiagnostics } from './aac'
import { injectMp4Metadata, type Mp4Chapter } from './mp4-metadata'
import { demuxMp4Video, type DemuxedVideo } from './mp4-video'
import { clampSegmentToMedia, type ExportPlan } from './plan'
import {
  PREVIEW_INTERVAL_MS,
  blitPreview,
  decodeClipAudio,
  drawCoverFrom,
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
 * universally; try higher AVC levels before abandoning MP4 (High@4.0 caps
 * near 1080p30 — clips from some cameras exceed it). WebM (VP9/VP8 + Opus)
 * is the last resort, and NEVER on iOS: nothing there shares or plays WebM
 * properly, and VP8/VP9 encoding is software-slow on iPhones (observed as a
 * "frozen" export that eventually produced an unusable .webm). A working
 * audio encoder is required — clips carry mic audio, so a silent WebCodecs
 * export would be strictly worse than the realtime fallback engine.
 */
async function pickCodecs(width: number, height: number): Promise<CodecChoice | null> {
  const aac = 'mp4a.40.2'
  const opus = 'opus'

  if (await isAudioConfigSupported(audioEncoderConfig(aac))) {
    // High profile at levels 4.0 → 5.1 (≈1080p30 → 4K).
    for (const avc of ['avc1.640028', 'avc1.640032', 'avc1.640033']) {
      if (await isVideoConfigSupported(videoEncoderConfig(avc, width, height))) {
        return { container: 'mp4', videoCodec: avc, audioCodec: aac }
      }
    }
  }
  if (isIosBrowser()) return null
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
  const probeClip = plan.segments[0].clip
  const probe = await loadClipVideo(probeClip.blob, 8000, probeClip.mimeType)
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
      console.warn('[export] encoder failure', err)
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
    encoderDescriptionHex: null,
    firstChunkPrefixHex: null,
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
    lastPreviewAtMs: 0,
  }

  const clipsInPlan = plan.segments.map((s) => s.clip)
  const multiDay = clipsSpanMultipleDays(clipsInPlan)

  try {
    for (const segment of plan.segments) {
      if (encoderError) throw encoderError

      // Fast path: demux the clip's own samples and decode with WebCodecs —
      // frame supply runs at hardware speed instead of 1× playback, and it
      // keeps working in background tabs (no compositor dependency).
      const isMp4Clip = /mp4/i.test(segment.clip.mimeType || segment.clip.blob.type)
      const demuxed = isMp4Clip
        ? await demuxMp4Video(segment.clip.blob).catch(() => null)
        : null

      let loaded: Awaited<ReturnType<typeof loadClipVideo>> | null = null
      try {
        let clamped = demuxed ? clampSegmentToMedia(segment, demuxed.durationMs) : null
        if (!clamped) {
          loaded = await loadClipVideo(segment.clip.blob, 8000, segment.clip.mimeType)
          clamped = clampSegmentToMedia(segment, loaded.mediaDurationMs)
        }
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

        const pumpShared = {
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
          onElapsedMs: (elapsed: number) => {
            if (plan.totalMs > 0) {
              onProgress?.(Math.min(1, (state.doneMs + elapsed) / plan.totalMs))
            }
          },
        }

        let pumped = false
        if (demuxed) {
          const outcome = await pumpSegmentVideoDecoded({ demuxed, ...pumpShared })
          pumped = outcome === 'done'
        }
        if (!pumped) {
          // Per-clip fallback: undecodable/unsupported clips play through a
          // video element like before (realtime-paced, but correct).
          console.info('[export] segment video path: element (realtime-paced)')
          loaded ??= await loadClipVideo(segment.clip.blob, 8000, segment.clip.mimeType)
          await pumpSegmentVideo({ video: loaded.video, ...pumpShared })
        }
        if (encoderError) throw encoderError

        state.outputOffsetUs += Math.round(segmentMs * 1000)
        state.doneMs += segmentMs
        onProgress?.(plan.totalMs > 0 ? Math.min(1, state.doneMs / plan.totalMs) : 1)
      } finally {
        loaded?.release()
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
      encoderDescriptionHex: aacDiagnostics.encoderDescriptionHex,
      firstChunkPrefixHex: aacDiagnostics.firstChunkPrefixHex,
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

interface PumpSharedArgs {
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
    lastPreviewAtMs: number
  }
  getPreviewCanvas?: () => HTMLCanvasElement | null
  watermarkImage?: HTMLImageElement | null
  hasError: () => boolean
  onElapsedMs: (elapsedMs: number) => void
}

interface PumpArgs extends PumpSharedArgs {
  video: HTMLVideoElement
}

/** Compose one source frame onto the encode canvas and encode it at its
 * rebased output timestamp — the common heart of both video pumps. */
function makeFrameEncoder({
  startSec,
  endSec,
  canvas,
  ctx,
  videoEncoder,
  state,
  getPreviewCanvas,
  watermarkImage,
}: PumpSharedArgs) {
  return (
    source: CanvasImageSource,
    sourceWidth: number,
    sourceHeight: number,
    mediaTimeSec: number,
  ): void => {
    const clampedSec = Math.min(Math.max(mediaTimeSec, startSec), endSec)
    let tsUs = state.outputOffsetUs + Math.round((clampedSec - startSec) * 1_000_000)
    if (tsUs <= state.lastVideoTsUs) {
      tsUs = state.lastVideoTsUs + 1000
    }
    drawCoverFrom(ctx, source, sourceWidth, sourceHeight, canvas.width, canvas.height)
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
    // Wall-clock throttled: the decoded pump can process frames far faster
    // than realtime, so per-frame-count sampling would burn time blitting.
    const now = performance.now()
    if (now - state.lastPreviewAtMs >= PREVIEW_INTERVAL_MS) {
      state.lastPreviewAtMs = now
      blitPreview(canvas, getPreviewCanvas?.())
    }
    if (state.frameCount % 30 === 0) {
      recordVideoLumaSample(canvas)
    }
    state.frameCount += 1
  }
}

/** Timer-free backpressure that keeps working in hidden tabs (setTimeout is
 * throttled there; codec dequeue events are not). The safety timeout only
 * guards against a dequeue landing between the check and the listen. */
function waitForDequeue(decoder: VideoDecoder, encoder: VideoEncoder): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    let timer = 0
    const done = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      decoder.removeEventListener('dequeue', done)
      encoder.removeEventListener('dequeue', done)
      resolve()
    }
    decoder.addEventListener('dequeue', done)
    encoder.addEventListener('dequeue', done)
    timer = window.setTimeout(done, 250)
  })
}

const DECODE_QUEUE_LIMIT = 12
const ENCODE_QUEUE_LIMIT = 12

interface DecodedPumpArgs extends PumpSharedArgs {
  demuxed: DemuxedVideo
}

/**
 * Decode-driven pump: feeds the clip's own samples through VideoDecoder at
 * hardware speed. Returns 'unsupported' (caller falls back to the element
 * pump) only when nothing was emitted yet; a mid-segment failure after
 * frames were encoded must abort the whole export instead — falling back
 * then would duplicate content.
 *
 * Samples are fed in DECODE order exactly as demuxed (B-frame safe); trim
 * filtering happens on the decoder's presentation-ordered output frames.
 */
async function pumpSegmentVideoDecoded({
  demuxed,
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
}: DecodedPumpArgs): Promise<'done' | 'unsupported'> {
  if (typeof VideoDecoder === 'undefined') return 'unsupported'
  if (!demuxed.codedWidth || !demuxed.codedHeight) return 'unsupported'

  const config: VideoDecoderConfig = {
    codec: demuxed.codec,
    codedWidth: demuxed.codedWidth,
    codedHeight: demuxed.codedHeight,
    ...(demuxed.description ? { description: demuxed.description } : {}),
  }
  try {
    const support = await VideoDecoder.isConfigSupported(config)
    if (!support.supported) return 'unsupported'
  } catch {
    return 'unsupported'
  }

  const startUs = Math.round(startSec * 1_000_000)
  const endUs = Math.round(endSec * 1_000_000)
  const encodeFrame = makeFrameEncoder({
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
  })

  let framesEmitted = 0
  let pumpError: unknown = null
  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        const pts = frame.timestamp
        // Frames decoded only to reach the trim-in keyframe are discarded.
        if (pts < startUs - 1_000 || pts >= endUs) return
        // Anchor each segment's first frame to the exact segment start (the
        // element pump did the same): clips whose first sample presents
        // late (B-frame reorder delay, edit lists) must not shift the
        // timeline — and the muxer requires the very first chunk at 0.
        const mediaSec = framesEmitted === 0 ? startSec : pts / 1_000_000
        encodeFrame(frame, frame.displayWidth, frame.displayHeight, mediaSec)
        framesEmitted += 1
        onElapsedMs((pts - startUs) / 1000)
      } catch (err) {
        pumpError ??= err
      } finally {
        frame.close()
      }
    },
    error: (err) => {
      pumpError ??= err
    },
  })

  try {
    decoder.configure(config)

    // Samples are in DECODE order (B-frames jump around in presentation
    // time), so the feed window is computed by scanning presentation times
    // across the whole list: start at the latest keyframe at/before the
    // trim-in point, stop after the last sample presented before trim-out.
    const samples = demuxed.samples
    let firstIndex = 0
    let bestSyncPts = -1
    let lastIndex = -1
    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i]!
      if (sample.isSync && sample.ptsUs <= startUs && sample.ptsUs > bestSyncPts) {
        bestSyncPts = sample.ptsUs
        firstIndex = i
      }
      if (sample.ptsUs < endUs) lastIndex = Math.max(lastIndex, i)
    }
    if (lastIndex < firstIndex) return 'unsupported'

    for (let i = firstIndex; i <= lastIndex; i += 1) {
      const sample = samples[i]!
      // Stall guard: waitForDequeue always resolves within its safety
      // timeout, so a wedged codec would otherwise spin here forever.
      const stallDeadline = performance.now() + 30_000
      while (
        !pumpError &&
        !hasError() &&
        (decoder.decodeQueueSize > DECODE_QUEUE_LIMIT ||
          videoEncoder.encodeQueueSize > ENCODE_QUEUE_LIMIT)
      ) {
        if (performance.now() > stallDeadline) {
          throw new Error('Export codec stalled (queues never drained)')
        }
        await waitForDequeue(decoder, videoEncoder)
      }
      if (pumpError || hasError()) break
      decoder.decode(
        new EncodedVideoChunk({
          type: sample.isSync ? 'key' : 'delta',
          timestamp: sample.ptsUs,
          duration: sample.durationUs,
          data: sample.data,
        }),
      )
    }

    if (!pumpError && !hasError()) {
      // A wedged decoder can also hang flush() itself.
      await Promise.race([
        decoder.flush(),
        new Promise((_, reject) => {
          window.setTimeout(() => reject(new Error('Export decoder flush stalled')), 30_000)
        }),
      ]).catch((err) => {
        pumpError ??= err
      })
    }
  } finally {
    try {
      if (decoder.state !== 'closed') decoder.close()
    } catch {
      // already closed
    }
  }

  if (hasError()) throw new Error('Export encoder failed')
  if (pumpError) {
    if (framesEmitted > 0) {
      throw pumpError instanceof Error ? pumpError : new Error('Decoded video pump failed')
    }
    return 'unsupported'
  }
  if (framesEmitted === 0) return 'unsupported'
  return 'done'
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

  const encodeFrame = makeFrameEncoder({
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
  })
  const encodeFrameAt = (mediaTimeSec: number) => {
    encodeFrame(video, video.videoWidth, video.videoHeight, mediaTimeSec)
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
