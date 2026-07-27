import { pickRecorderMimeType } from '../media'
import { clampSegmentToMedia, type ExportPlan } from './plan'
import {
  PREVIEW_EVERY_N_FRAMES,
  blitPreview,
  decodeClipAudio,
  drawCover,
  drawWatermark,
  loadClipVideo,
  pickOutputSize,
  seekTo,
  wait,
  type ExportResult,
} from './shared'

export interface RealtimeExportOptions {
  /**
   * AudioContext created/resumed from the user's tap so Android allows audio
   * mixing. The export closes it when finished.
   */
  audioContext?: AudioContext
  onProgress?: (ratio: number) => void
  /** Visible canvas to mirror sampled frames onto while exporting. */
  getPreviewCanvas?: () => HTMLCanvasElement | null
  /** Mark stamped onto each frame; null when the user purchased removal. */
  watermarkImage?: HTMLImageElement | null
}

/**
 * Fallback stitcher for browsers without WebCodecs: plays each clip into a
 * canvas captured by MediaRecorder, mixing audio via Web Audio. Realtime and
 * best-effort — the WebCodecs engine is preferred whenever available.
 */
export async function exportRealtime(
  plan: ExportPlan,
  options: RealtimeExportOptions = {},
): Promise<ExportResult> {
  const probe = await loadClipVideo(plan.segments[0].clip.blob)
  const { width, height } = pickOutputSize(probe.video.videoWidth, probe.video.videoHeight)
  probe.release()

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Canvas not available')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)

  const canvasStream = canvas.captureStream(30)
  if (canvasStream.getVideoTracks().length === 0) {
    throw new Error('This browser cannot capture canvas video for export')
  }

  let audioContext: AudioContext | null = options.audioContext ?? null
  let dest: MediaStreamAudioDestinationNode | null = null
  try {
    if (!audioContext) audioContext = new AudioContext()
    if (audioContext.state === 'suspended') {
      await audioContext.resume().catch(() => undefined)
    }
    dest = audioContext.createMediaStreamDestination()
  } catch {
    audioContext = null
    dest = null
  }

  const mixedStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...(dest?.stream.getAudioTracks() ?? []),
  ])

  const mimeType = pickRecorderMimeType()
  let recorder: MediaRecorder
  try {
    recorder = mimeType
      ? new MediaRecorder(mixedStream, { mimeType, videoBitsPerSecond: 3_000_000 })
      : new MediaRecorder(mixedStream)
  } catch {
    recorder = new MediaRecorder(mixedStream)
  }

  const chunks: BlobPart[] = []
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }
  const stopped = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'video/webm' }))
    recorder.onerror = () => reject(new Error('Export recording failed'))
  })

  recorder.start(200)
  await wait(120)

  let paintedTotalMs = 0
  const frameCounter = { count: 0 }
  try {
    for (const segment of plan.segments) {
      const loaded = await loadClipVideo(segment.clip.blob)
      try {
        const clamped = clampSegmentToMedia(segment, loaded.mediaDurationMs)
        if (!clamped) continue
        const paintedMs = await paintSegment({
          video: loaded.video,
          blob: segment.clip.blob,
          startSec: clamped.startMs / 1000,
          endSec: clamped.endMs / 1000,
          canvas,
          ctx,
          audioContext,
          dest,
          frameCounter,
          getPreviewCanvas: options.getPreviewCanvas,
          watermarkImage: options.watermarkImage ?? null,
          onElapsedMs: (elapsed) => {
            if (plan.totalMs > 0) {
              options.onProgress?.(Math.min(1, (paintedTotalMs + elapsed) / plan.totalMs))
            }
          },
        })
        paintedTotalMs += paintedMs
        options.onProgress?.(plan.totalMs > 0 ? Math.min(1, paintedTotalMs / plan.totalMs) : 1)
      } finally {
        loaded.release()
      }
    }

    if (paintedTotalMs <= 0) {
      throw new Error('No video frames could be exported')
    }

    // Hold the last frame briefly so the final GOP isn't truncated.
    await wait(180)
    options.onProgress?.(1)
  } finally {
    if (recorder.state !== 'inactive') recorder.stop()
    canvasStream.getTracks().forEach((t) => t.stop())
    if (audioContext) {
      await audioContext.close().catch(() => undefined)
    }
  }

  const blob = await stopped
  if (blob.size < 8_000) {
    throw new Error('Export produced an unusable file')
  }
  const isMp4 = (recorder.mimeType || '').includes('mp4')
  return {
    blob,
    mimeType: blob.type || 'video/webm',
    fileExtension: isMp4 ? 'mp4' : 'webm',
  }
}

interface PaintSegmentArgs {
  video: HTMLVideoElement
  blob: Blob
  startSec: number
  endSec: number
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  audioContext: AudioContext | null
  dest: MediaStreamAudioDestinationNode | null
  frameCounter: { count: number }
  getPreviewCanvas?: () => HTMLCanvasElement | null
  watermarkImage: HTMLImageElement | null
  onElapsedMs: (elapsedMs: number) => void
}

/** @returns painted duration in ms (0 when the segment had nothing to show) */
async function paintSegment({
  video,
  blob,
  startSec,
  endSec,
  canvas,
  ctx,
  audioContext,
  dest,
  frameCounter,
  getPreviewCanvas,
  watermarkImage,
  onElapsedMs,
}: PaintSegmentArgs): Promise<number> {
  const segmentSec = endSec - startSec
  if (segmentSec <= 0.04) return 0

  await seekTo(video, startSec)

  let bufferSource: AudioBufferSourceNode | null = null
  const audioBuffer = audioContext && dest ? await decodeClipAudio(blob) : null

  try {
    video.muted = true
    await video.play()
    await waitForPlaybackStart(video, startSec)

    const paintFrame = () => {
      drawCover(ctx, video, canvas.width, canvas.height)
      if (watermarkImage) {
        drawWatermark(ctx, watermarkImage, canvas.width, canvas.height)
      }
    }
    paintFrame()

    if (audioContext && dest && audioBuffer) {
      const videoLeadSec = Math.max(0, video.currentTime - startSec)
      const offset = Math.min(startSec + videoLeadSec, Math.max(0, audioBuffer.duration - 0.01))
      const available = Math.max(0, audioBuffer.duration - offset)
      const playDuration = Math.max(0, Math.min(segmentSec - videoLeadSec, available))
      if (playDuration > 0.05) {
        try {
          bufferSource = audioContext.createBufferSource()
          bufferSource.buffer = audioBuffer
          bufferSource.connect(dest)
          bufferSource.start(audioContext.currentTime, offset, playDuration)
        } catch {
          bufferSource = null
        }
      }
    }

    await new Promise<void>((resolve, reject) => {
      let raf = 0
      let lastFrameAt = performance.now()
      let lastVideoTime = video.currentTime

      const finish = () => {
        paintFrame()
        cancelAnimationFrame(raf)
        video.pause()
        resolve()
      }

      const draw = () => {
        const now = performance.now()
        const elapsed = Math.max(0, video.currentTime - startSec)
        if (video.ended || video.currentTime >= endSec - 0.04 || elapsed >= segmentSec - 0.03) {
          finish()
          return
        }
        if (video.currentTime > lastVideoTime + 0.001) {
          lastVideoTime = video.currentTime
          lastFrameAt = now
        } else if (now - lastFrameAt > 8000) {
          cancelAnimationFrame(raf)
          video.pause()
          reject(new Error('Clip playback stalled during export'))
          return
        }
        paintFrame()
        if (frameCounter.count % PREVIEW_EVERY_N_FRAMES === 0) {
          blitPreview(canvas, getPreviewCanvas?.())
        }
        frameCounter.count += 1
        onElapsedMs(Math.min(segmentSec, elapsed) * 1000)
        raf = requestAnimationFrame(draw)
      }

      video.onerror = () => {
        cancelAnimationFrame(raf)
        reject(new Error('A clip failed to play during export'))
      }
      raf = requestAnimationFrame(draw)
    })

    return Math.round(segmentSec * 1000)
  } finally {
    video.onerror = null
    try {
      bufferSource?.stop()
    } catch {
      // already ended
    }
    bufferSource?.disconnect()
  }
}

async function waitForPlaybackStart(video: HTMLVideoElement, startSec: number): Promise<void> {
  if (video.currentTime > startSec + 0.01) return
  const deadline = performance.now() + 1500
  await new Promise<void>((resolve) => {
    const tick = () => {
      if (video.currentTime > startSec + 0.01 || video.ended || performance.now() > deadline) {
        resolve()
        return
      }
      requestAnimationFrame(tick)
    }
    tick()
  })
}
