import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  type AudioCodec,
  type VideoCodec,
} from 'mediabunny'
import { deriveProjectLocation } from '../geo'
import { isIosBrowser } from '../platform'
import type { ClipRecord } from '../types'
import { injectMp4Metadata, type Mp4Chapter } from './mp4-metadata'
import { createOpfsExportFile } from './opfs'
import { clampSegmentToMedia, type ExportPlan } from './plan'
import {
  PREVIEW_INTERVAL_MS,
  blitPreview,
  decodeClipAudio,
  drawWatermark,
  loadClipVideo,
  tagExportError,
  pickOutputSize,
  recordVideoLumaSample,
  seekTo,
  waitForPreviewCanvas,
  type ExportResult,
} from './shared'

const FPS = 30
const AUDIO_SAMPLE_RATE = 48000
const AUDIO_CHANNELS = 2
const AUDIO_BITRATE = 192_000
const KEYFRAME_INTERVAL_SEC = 2
// Decimation to the output frame rate runs against a virtual 30fps output
// clock (see makeFrameSink): high-rate sources otherwise push extra frames
// through the same bitrate budget, cutting bits-per-frame — that was the
// source of the blocky artifacts on long exports. The tolerance admits a
// frame slightly ahead of its tick so a jittery 30fps source never drops
// legitimate frames.
const FRAME_INTERVAL_SEC = 1 / FPS
const DECIMATE_TOLERANCE_SEC = 0.3 / FPS

/** ~0.12 bits per pixel at 30fps — clean hardware-AVC territory without
 * ballooning the file. Scales down for small outputs instead of spending a
 * flat 4Mbps on everything. */
function videoBitrateFor(width: number, height: number): number {
  return Math.round(Math.min(6_000_000, Math.max(1_500_000, width * height * FPS * 0.12)))
}

export function supportsWebCodecsExport(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined'
}

interface CodecChoice {
  container: 'mp4' | 'webm'
  videoCodec: VideoCodec
  audioCodec: AudioCodec
}

/**
 * MP4 (H.264/HEVC + AAC) is strongly preferred: it's what every share
 * target, phone gallery, and player accepts. WebM (VP9/VP8 + Opus) is the
 * last resort for browsers without MP4 encoders (e.g. Chromium builds
 * without proprietary codecs) — and NEVER on iOS, where nothing plays or
 * shares WebM and VP encoding is software-slow. Mediabunny probes actual
 * encodability, including at the output dimensions.
 */
async function pickCodecs(width: number, height: number): Promise<CodecChoice | null> {
  const mp4Video = await getFirstEncodableVideoCodec(['avc', 'hevc'], { width, height })
  const mp4Audio = await getFirstEncodableAudioCodec(['aac'], {
    numberOfChannels: AUDIO_CHANNELS,
    sampleRate: AUDIO_SAMPLE_RATE,
  })
  if (mp4Video && mp4Audio) {
    return { container: 'mp4', videoCodec: mp4Video, audioCodec: mp4Audio }
  }
  if (isIosBrowser()) return null
  const webmVideo = await getFirstEncodableVideoCodec(['vp9', 'vp8'], { width, height })
  const webmAudio = await getFirstEncodableAudioCodec(['opus'], {
    numberOfChannels: AUDIO_CHANNELS,
    sampleRate: AUDIO_SAMPLE_RATE,
  })
  if (webmVideo && webmAudio) {
    return { container: 'webm', videoCodec: webmVideo, audioCodec: webmAudio }
  }
  return null
}

/**
 * Frame-accurate export built on Mediabunny: each clip's samples are
 * demuxed and decoded directly (no playback, no compositor dependency — the
 * frame supply runs at hardware speed and keeps flowing in background
 * tabs), composited onto one canvas with the watermark, and encoded/muxed
 * by Mediabunny, which owns the codec-config, packet-ordering, and
 * container details we used to hand-roll (and debug, chunk by chunk, on
 * iOS). Audio is decoded per clip and appended sample-accurately, so clips
 * can never drift against their soundtrack.
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

  const { width, height } = await probeOutputSize(plan)
  const choice = await pickCodecs(width, height)
  if (!choice) {
    throw new Error('No supported export codec')
  }

  // iOS ONLY: encode into the on-DOM overlay canvas — WebKit has a history
  // of treating detached canvases as black in capture paths (see the
  // black-export saga). Everywhere else the encode canvas stays DETACHED:
  // drawing every frame through a visible, compositor-synchronized canvas
  // rate-limited a 9× export to a constant ~6× on Android. The preview gets
  // throttled downscaled blits instead — it only shows what's processing.
  let canvas = isIosBrowser() ? await waitForPreviewCanvas(getPreviewCanvas) : null
  const encodingIntoPreview = canvas !== null
  if (!canvas) {
    canvas = document.createElement('canvas')
  }
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Canvas not available')

  // Stream the mux to disk when OPFS is available: long exports are too
  // big for an in-memory buffer (a half-hour project is ~1GB — the
  // BufferTarget path OOM-killed the tab right at 100%).
  const opfs = await createOpfsExportFile(choice.container)
  const output = new Output({
    format:
      choice.container === 'mp4'
        ? // Trailing moov so chapter/geotag injection can append udta
          // without rewriting stco/co64. Exports are saved/shared, not
          // streamed, so faststart matters little here.
          new Mp4OutputFormat({ fastStart: false })
        : new WebMOutputFormat(),
    target: opfs ? new StreamTarget(opfs.writable, { chunked: true }) : new BufferTarget(),
  })
  const videoSource = new CanvasSource(canvas, {
    codec: choice.videoCodec,
    quality: new Quality({ bitrate: videoBitrateFor(width, height) }),
    keyFrameInterval: KEYFRAME_INTERVAL_SEC,
  })
  output.addVideoTrack(videoSource, { frameRate: FPS })
  const audioSource = new AudioBufferSource({
    codec: choice.audioCodec,
    quality: new Quality({ bitrate: AUDIO_BITRATE }),
  })
  output.addAudioTrack(audioSource)
  await output.start()

  const state: PumpState = {
    lastVideoTsSec: -1,
    nextFrameTsSec: 0,
    outputOffsetSec: 0,
    doneMs: 0,
    frameCount: 0,
    lastPreviewAtMs: 0,
  }

  const clipsInPlan = plan.segments.map((s) => s.clip)
  const multiDay = clipsSpanMultipleDays(clipsInPlan)
  const chapters: Mp4Chapter[] = []

  try {
    for (const [segmentIndex, segment] of plan.segments.entries()) {
      const input = new Input({
        source: new BlobSource(segment.clip.blob),
        formats: ALL_FORMATS,
      })

      let loaded: Awaited<ReturnType<typeof loadClipVideo>> | null = null
      try {
        const mediaDurationMs = await input
          .computeDuration()
          .then((seconds) => Math.round(seconds * 1000))
          .catch(() => 0)
        let clamped = mediaDurationMs > 0 ? clampSegmentToMedia(segment, mediaDurationMs) : null
        if (!clamped) {
          try {
            loaded = await loadClipVideo(segment.clip.blob, 8000, segment.clip.mimeType)
            clamped = clampSegmentToMedia(segment, loaded.mediaDurationMs)
          } catch (error) {
            // A stubborn element load (iOS WebKit can refuse a blob it
            // recorded itself — KODY-VIDEO-A) must not kill the export when
            // it was only measuring duration: the recorder already measured
            // this clip's real media duration at capture time. Only the
            // element PUMP truly needs the element.
            clamped = clampSegmentToMedia(segment, segment.clip.durationMs)
            if (!clamped) {
              throw tagExportError(error, {
                engine: 'webcodecs',
                where: 'clip-duration',
                clipIndex: segmentIndex,
              })
            }
          }
        }
        if (!clamped) continue
        const segmentMs = clamped.endMs - clamped.startMs

        if (choice.container === 'mp4') {
          chapters.push({
            startMs: Math.round(state.outputOffsetSec * 1000),
            title: formatChapterTitle(segment.clip, multiDay),
          })
        }

        // Audio first: decoded per clip, sliced to the exact segment window
        // (silence-padded), appended sequentially — timestamps are implied
        // by position, so segments can never drift.
        const buffer = await decodeClipAudio(segment.clip.blob, AUDIO_SAMPLE_RATE)
        await audioSource.add(sliceSegmentAudio(buffer, clamped.startMs, segmentMs))

        const pumpShared: PumpSharedArgs = {
          startSec: clamped.startMs / 1000,
          endSec: clamped.endMs / 1000,
          canvas,
          ctx,
          videoSource,
          state,
          // No mirroring needed when the encode canvas is the preview.
          getPreviewCanvas: encodingIntoPreview ? undefined : getPreviewCanvas,
          watermarkImage,
          onElapsedMs: (elapsed: number) => {
            if (plan.totalMs > 0) {
              onProgress?.(Math.min(1, (state.doneMs + elapsed) / plan.totalMs))
            }
          },
        }

        let pumped = false
        const outcome = await pumpSegmentVideoDecoded({ input, ...pumpShared })
        pumped = outcome === 'done'
        if (!pumped) {
          // Per-clip fallback: undecodable/unsupported clips play through a
          // video element like before (realtime-paced, but correct).
          console.info('[export] segment video path: element (realtime-paced)')
          try {
            loaded ??= await loadClipVideo(segment.clip.blob, 8000, segment.clip.mimeType)
          } catch (error) {
            throw tagExportError(error, {
              engine: 'webcodecs',
              where: 'element-pump',
              clipIndex: segmentIndex,
            })
          }
          await pumpSegmentVideo({ video: loaded.video, ...pumpShared })
        }

        state.outputOffsetSec += segmentMs / 1000
        state.doneMs += segmentMs
        onProgress?.(plan.totalMs > 0 ? Math.min(1, state.doneMs / plan.totalMs) : 1)
      } finally {
        loaded?.release()
      }
    }

    if (state.lastVideoTsSec < 0) {
      throw new Error('No video frames could be exported')
    }

    await output.finalize()
  } catch (error) {
    await output.cancel().catch(() => undefined)
    await opfs?.discard().catch(() => undefined)
    throw error
  }

  onProgress?.(1)
  const mimeType = choice.container === 'mp4' ? 'video/mp4' : 'video/webm'
  let blob: Blob
  if (opfs) {
    const file = await opfs.getFile()
    if (file.size === 0) throw new Error('Export produced no data')
    // Blob composition references the disk-backed file — no RAM copy.
    blob = new Blob([file], { type: mimeType })
  } else {
    const buffer = (output.target as BufferTarget).buffer
    if (!buffer) throw new Error('Export produced no data')
    blob = new Blob([buffer], { type: mimeType })
  }
  const diskBlob = blob
  if (choice.container === 'mp4') {
    blob = await injectMetadataBestEffort(blob, mimeType, chapters, clipsInPlan)
  }
  return {
    blob,
    mimeType,
    fileExtension: choice.container,
    opfsName: opfs?.name,
    // Metadata injection returns a NEW in-memory blob; when it ran, the
    // on-disk file no longer matches what the user gets.
    opfsBacked: opfs !== null && blob === diskBlob,
  }
}

/** Metadata injection needs the whole file in memory (once) — worth it for
 * chapters/geotags on normal exports, but never worth risking a very long
 * export over: oversized files skip it, and any failure returns the
 * perfectly playable un-injected file. */
const METADATA_INJECT_LIMIT_BYTES = 256 * 1024 * 1024

async function injectMetadataBestEffort(
  blob: Blob,
  mimeType: string,
  chapters: Mp4Chapter[],
  clipsInPlan: ClipRecord[],
): Promise<Blob> {
  if (blob.size > METADATA_INJECT_LIMIT_BYTES) return blob
  try {
    const injected = injectMp4Metadata(await blob.arrayBuffer(), {
      chapters,
      location: deriveProjectLocation(clipsInPlan),
    })
    return new Blob([injected], { type: mimeType })
  } catch {
    return blob
  }
}

/** Output dimensions from the first clip's real (rotated) display size. */
async function probeOutputSize(plan: ExportPlan): Promise<{ width: number; height: number }> {
  const clip = plan.segments[0]!.clip
  try {
    const input = new Input({ source: new BlobSource(clip.blob), formats: ALL_FORMATS })
    const track = await input.getPrimaryVideoTrack()
    if (track && track.displayWidth > 0 && track.displayHeight > 0) {
      return pickOutputSize(track.displayWidth, track.displayHeight)
    }
  } catch {
    // Fall through to the element probe.
  }
  try {
    const probe = await loadClipVideo(clip.blob, 8000, clip.mimeType)
    try {
      return pickOutputSize(probe.video.videoWidth, probe.video.videoHeight)
    } finally {
      probe.release()
    }
  } catch (error) {
    // Recorded clips carry their capture dimensions — probing must never be
    // the reason an export dies (pickOutputSize also has sane defaults).
    if ((clip.width ?? 0) > 0 && (clip.height ?? 0) > 0) {
      return pickOutputSize(clip.width!, clip.height!)
    }
    throw tagExportError(error, { engine: 'webcodecs', where: 'probe-size', clipIndex: 0 })
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

interface PumpState {
  lastVideoTsSec: number
  /** Next 30fps output-clock tick; frames arriving before it are dropped. */
  nextFrameTsSec: number
  outputOffsetSec: number
  doneMs: number
  frameCount: number
  lastPreviewAtMs: number
}

interface PumpSharedArgs {
  startSec: number
  endSec: number
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  videoSource: CanvasSource
  state: PumpState
  getPreviewCanvas?: () => HTMLCanvasElement | null
  watermarkImage?: HTMLImageElement | null
  onElapsedMs: (elapsedMs: number) => void
}

/** Compose one source frame onto the encode canvas and hand it to the
 * encoder at its rebased output timestamp — the heart of both pumps.
 * Awaiting the returned promise applies encoder backpressure. */
function makeFrameSink({
  startSec,
  endSec,
  canvas,
  ctx,
  videoSource,
  state,
  getPreviewCanvas,
  watermarkImage,
}: PumpSharedArgs) {
  return (
    draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void,
    mediaTimeSec: number,
    options?: { force?: boolean },
  ): Promise<void> => {
    const clampedSec = Math.min(Math.max(mediaTimeSec, startSec), endSec)
    let tsSec = state.outputOffsetSec + (clampedSec - startSec)
    // Decimate against the output clock: emit one frame per 30fps tick and
    // drop the rest, so ANY source rate (40, 60, 120fps) caps at exactly
    // FPS long-run — a fixed minimum gap would let a 40fps source through
    // untouched. Segment anchor frames are forced: every segment must
    // contribute at least its first frame.
    if (!options?.force && tsSec < state.nextFrameTsSec - DECIMATE_TOLERANCE_SEC) {
      return Promise.resolve()
    }
    // Stay on the tick grid while the source keeps up; resync from the
    // frame itself across gaps (slow sources, segment jumps).
    state.nextFrameTsSec = Math.max(state.nextFrameTsSec, tsSec) + FRAME_INTERVAL_SEC
    if (tsSec <= state.lastVideoTsSec) {
      tsSec = state.lastVideoTsSec + 0.001
    }
    draw(ctx, canvas.width, canvas.height)
    if (watermarkImage) {
      drawWatermark(ctx, watermarkImage, canvas.width, canvas.height)
    }
    state.lastVideoTsSec = tsSec
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
    return videoSource.add(tsSec, 1 / FPS)
  }
}

interface DecodedPumpArgs extends PumpSharedArgs {
  input: Input
}

/**
 * Decode-driven pump: Mediabunny's CanvasSink demuxes and decodes the
 * clip's own samples (B-frame ordering, decoder configs, and the file's
 * rotation metadata all handled by the library) and yields frames already
 * cover-fitted to the output size. Returns 'unsupported' (caller falls
 * back to the element pump) only when nothing was emitted yet; a failure
 * after frames were encoded aborts the whole export instead — falling back
 * then would duplicate content.
 */
async function pumpSegmentVideoDecoded(
  args: DecodedPumpArgs,
): Promise<'done' | 'unsupported'> {
  const { input, startSec, endSec, canvas, onElapsedMs } = args
  const emit = makeFrameSink(args)

  let track
  try {
    track = await input.getPrimaryVideoTrack()
    if (!track || !(await track.canDecode())) return 'unsupported'
  } catch {
    return 'unsupported'
  }

  const sink = new CanvasSink(track, {
    width: canvas.width,
    height: canvas.height,
    fit: 'cover',
    poolSize: 2,
  })

  let framesEmitted = 0
  try {
    // Long segments on slow decoders still finish well inside this; a
    // wedged decoder must not hang the export forever.
    const deadline = performance.now() + Math.max(120_000, (endSec - startSec) * 5000)
    for await (const wrapped of sink.canvases(startSec, endSec)) {
      if (performance.now() > deadline) {
        throw new Error('Export decode stalled')
      }
      // Anchor each segment's first frame to the exact segment start:
      // clips whose first sample presents late (B-frame reorder delay,
      // edit lists) must not shift the timeline — and the container's
      // first chunk must sit at 0.
      const mediaSec = framesEmitted === 0 ? startSec : wrapped.timestamp
      await emit((ctx) => ctx.drawImage(wrapped.canvas, 0, 0), mediaSec, {
        force: framesEmitted === 0,
      })
      framesEmitted += 1
      onElapsedMs((Math.min(wrapped.timestamp, endSec) - startSec) * 1000)
    }
  } catch (err) {
    if (framesEmitted > 0) {
      throw err instanceof Error ? err : new Error('Decoded video pump failed')
    }
    return 'unsupported'
  }

  if (framesEmitted === 0) return 'unsupported'
  return 'done'
}

interface PumpArgs extends PumpSharedArgs {
  video: HTMLVideoElement
}

/**
 * Element-pump fallback for clips WebCodecs cannot decode: plays the clip
 * muted and captures composited frames. Realtime-paced by nature — only
 * used when the decoded pump can't run.
 */
async function pumpSegmentVideo({
  video,
  ...shared
}: PumpArgs): Promise<void> {
  const { startSec, endSec, onElapsedMs } = shared
  await seekTo(video, startSec)

  const emit = makeFrameSink(shared)
  // The draw happens SYNCHRONOUSLY at callback time (frame and timestamp
  // must belong together); the returned promise carries encoder
  // backpressure and paces when the next frame is processed.
  const emitAt = (mediaTimeSec: number, options?: { force?: boolean }): Promise<void> =>
    emit(
      (ctx, width, height) => {
        const vw = video.videoWidth || width
        const vh = video.videoHeight || height
        const scale = Math.max(width / vw, height / vh)
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, width, height)
        ctx.drawImage(
          video,
          (width - vw * scale) / 2,
          (height - vh * scale) / 2,
          vw * scale,
          vh * scale,
        )
      },
      mediaTimeSec,
      options,
    )

  // Guarantee at least one frame per segment, even if playback ends instantly.
  await emitAt(startSec, { force: true })

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
        if (mediaTimeSec > lastMediaTime + 0.001) {
          lastMediaTime = mediaTimeSec
          lastProgressAt = performance.now()
        }
        if (video.ended || mediaTimeSec >= endSec - 0.005) {
          finish()
          return
        }
        if (mediaTimeSec > startSec) {
          // Draw now (synchronously — this frame belongs to this timestamp),
          // then let the encoder's backpressure pace the next callback.
          // While it drains, playback continues and frames are skipped —
          // realtime-fallback semantics, same as pausing would produce.
          onElapsedMs((mediaTimeSec - startSec) * 1000)
          emitAt(mediaTimeSec).then(scheduleNext, (err) => {
            abort(err instanceof Error ? err : new Error('Export encoder failed'))
          })
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

/** Boundary ramp length: long enough to kill clicks, far too short to hear. */
const AUDIO_FADE_FRAMES = Math.round(0.003 * AUDIO_SAMPLE_RATE)

/**
 * Exactly `segmentMs` of audio for a segment: the decoded clip audio sliced
 * at the trim-in point, padded with silence where the clip has less audio
 * than video. Slice edges get ~3ms fades — a hard cut mid-waveform at every
 * clip joint is an audible click, which is exactly the "audio isn't
 * seamless like the video" report.
 */
function sliceSegmentAudio(
  buffer: AudioBuffer | null,
  startMs: number,
  segmentMs: number,
): AudioBuffer {
  const totalFrames = Math.max(1, Math.round((segmentMs / 1000) * AUDIO_SAMPLE_RATE))
  const slice = new AudioBuffer({
    length: totalFrames,
    sampleRate: AUDIO_SAMPLE_RATE,
    numberOfChannels: AUDIO_CHANNELS,
  })
  if (!buffer) return slice

  const sourceRate = buffer.sampleRate
  const sourceStartFrame = Math.floor((startMs / 1000) * sourceRate)
  let copiedFrames = 0
  for (let ch = 0; ch < AUDIO_CHANNELS; ch += 1) {
    const source = buffer.getChannelData(Math.min(ch, buffer.numberOfChannels - 1))
    const target = slice.getChannelData(ch)
    let copied = 0
    for (let i = 0; i < totalFrames; i += 1) {
      const src = sourceStartFrame + i
      if (src >= source.length) break
      target[i] = source[src]!
      copied += 1
    }
    copiedFrames = Math.max(copiedFrames, copied)
  }

  // Fade in from the cut point and out into the cut/padding.
  const fade = Math.min(AUDIO_FADE_FRAMES, Math.floor(copiedFrames / 2))
  if (fade > 0) {
    for (let ch = 0; ch < AUDIO_CHANNELS; ch += 1) {
      const target = slice.getChannelData(ch)
      for (let i = 0; i < fade; i += 1) {
        const gain = i / fade
        target[i]! *= gain
        target[copiedFrames - 1 - i]! *= gain
      }
    }
  }
  return slice
}
