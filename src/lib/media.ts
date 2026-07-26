import type { ClipRecord } from './types'
import { effectiveDurationMs } from './types'

export type FacingMode = 'environment' | 'user'

export interface CameraPermissionState {
  status: 'prompt' | 'granted' | 'denied' | 'unsupported' | 'unknown'
  message?: string
}

export function isMediaDevicesSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
}

export async function queryCameraPermission(): Promise<CameraPermissionState> {
  if (!isMediaDevicesSupported()) {
    return {
      status: 'unsupported',
      message: 'Camera APIs are not available in this browser. Use HTTPS Chrome/Android or localhost.',
    }
  }

  try {
    if (navigator.permissions?.query) {
      const result = await navigator.permissions.query({
        name: 'camera' as PermissionName,
      })
      if (result.state === 'granted') return { status: 'granted' }
      if (result.state === 'denied') {
        return {
          status: 'denied',
          message: 'Camera access is blocked. Enable it in browser site settings, then reload.',
        }
      }
      return { status: 'prompt' }
    }
  } catch {
    // Safari and some browsers don't support camera permission query.
  }
  return { status: 'unknown' }
}

export interface OpenCameraOptions {
  /** Preview should stay video-only so Android voice-to-text can use the mic. */
  audio?: boolean
}

export async function openCameraStream(
  facing: FacingMode,
  options: OpenCameraOptions = {},
): Promise<MediaStream> {
  const withAudio = options.audio === true
  const videoConstraints: MediaTrackConstraints = {
    facingMode: { ideal: facing },
    width: { ideal: 1280 },
    height: { ideal: 720 },
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: withAudio,
      video: videoConstraints,
    })
  } catch (error) {
    if (isOverconstrained(error)) {
      return navigator.mediaDevices.getUserMedia({
        audio: withAudio,
        video: true,
      })
    }
    throw error
  }
}

/** Grab a mic track only for the duration of a recording. */
export async function openMicrophoneTrack(): Promise<MediaStreamTrack> {
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
    },
    video: false,
  })
  const track = mic.getAudioTracks()[0]
  if (!track) {
    mic.getTracks().forEach((t) => t.stop())
    throw new Error('No microphone track available')
  }
  return track
}

function isOverconstrained(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'OverconstrainedError'
}

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop())
}

export function stopAudioTracks(stream: MediaStream | null | undefined): void {
  stream?.getAudioTracks().forEach((track) => {
    stream.removeTrack(track)
    track.stop()
  })
}

export function pickRecorderMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ]
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) {
      return type
    }
  }
  return ''
}

export function measureBlobDuration(blob: Blob): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    video.playsInline = true

    const cleanup = () => {
      URL.revokeObjectURL(url)
      video.removeAttribute('src')
      video.load()
    }

    video.onloadedmetadata = () => {
      if (!Number.isFinite(video.duration) || video.duration === Infinity) {
        video.currentTime = Number.MAX_SAFE_INTEGER
        video.ontimeupdate = () => {
          const durationMs = Math.max(0, Math.round((video.duration || 0) * 1000))
          cleanup()
          resolve(durationMs)
        }
        return
      }
      const durationMs = Math.max(0, Math.round(video.duration * 1000))
      cleanup()
      resolve(durationMs)
    }
    video.onerror = () => {
      cleanup()
      reject(new Error('Could not read clip duration'))
    }
    video.src = url
  })
}

export async function canFlipCamera(): Promise<boolean> {
  if (!navigator.mediaDevices?.enumerateDevices) return false
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const videos = devices.filter((d) => d.kind === 'videoinput')
    return videos.length > 1
  } catch {
    return false
  }
}

function isMobileBrowser(): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}

export interface ExportWebmOptions {
  /**
   * Prefer creating/resuming this from the Make-video click so Android unlocks audio.
   * Export closes the context when finished.
   */
  audioContext?: AudioContext
}

/**
 * Stitch clips into a single WebM using canvas captureStream + MediaRecorder.
 * Applies trim in/out by seeking each source clip.
 * Audio is mixed from decodeAudioData → BufferSource (muted video frames for autoplay).
 */
export async function exportProjectAsWebm(
  clips: ClipRecord[],
  onProgress?: (ratio: number) => void,
  options: ExportWebmOptions = {},
): Promise<Blob> {
  if (clips.length === 0) {
    throw new Error('Nothing to export')
  }

  // Portrait output matches phone capture; keep moderate for mobile encoders.
  const width = isMobileBrowser() ? 540 : 720
  const height = isMobileBrowser() ? 960 : 1280
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Canvas not available')

  // Warm the canvas so captureStream has a first frame on Chromium Android.
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)

  const canvasStream = canvas.captureStream(30)
  if (canvasStream.getVideoTracks().length === 0) {
    throw new Error('This browser cannot capture canvas video for export')
  }

  let audioContext: AudioContext | null = options.audioContext ?? null
  let dest: MediaStreamAudioDestinationNode | null = null
  try {
    if (!audioContext) {
      audioContext = new AudioContext()
    }
    if (audioContext.state === 'suspended') {
      await audioContext.resume().catch(() => undefined)
    }
    dest = audioContext.createMediaStreamDestination()
  } catch {
    // Video-only export if AudioContext is unavailable.
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
      ? new MediaRecorder(mixedStream, {
          mimeType: mimeType.includes('webm') || mimeType.includes('mp4') ? mimeType : undefined,
          videoBitsPerSecond: isMobileBrowser() ? 1_500_000 : 2_500_000,
        })
      : new MediaRecorder(mixedStream)
  } catch {
    recorder = new MediaRecorder(mixedStream)
  }

  const chunks: BlobPart[] = []
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }

  const stopped = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: recorder.mimeType || 'video/webm' }))
    }
    recorder.onerror = () => reject(new Error('Export recording failed'))
  })

  recorder.start(200)

  // Give the recorder a moment to latch onto the canvas track.
  await wait(120)

  const totalMs = clips.reduce((sum, clip) => sum + effectiveDurationMs(clip), 0)
  let elapsed = 0

  try {
    for (const clip of clips) {
      const clipMs = effectiveDurationMs(clip)
      if (clipMs < 40) continue
      await paintClipToCanvas({
        clip,
        canvas,
        ctx,
        audioContext,
        dest,
        onFrameProgress: (clipElapsed) => {
          if (totalMs > 0) onProgress?.((elapsed + clipElapsed) / totalMs)
        },
      })
      elapsed += clipMs
      onProgress?.(totalMs > 0 ? elapsed / totalMs : 1)
    }

    // Hold the last frame briefly so the final GOP isn't truncated.
    await wait(180)
  } finally {
    if (recorder.state !== 'inactive') recorder.stop()
    canvasStream.getTracks().forEach((t) => t.stop())
    if (audioContext) {
      await audioContext.close().catch(() => undefined)
    }
  }

  const blob = await stopped
  const minBytes = Math.max(8_000, Math.floor(totalMs * 4))
  if (blob.size < minBytes) {
    throw new Error(
      `Export produced an unusable file (${Math.round(blob.size / 1024)}KB). Try “Files” instead.`,
    )
  }
  return blob
}

interface PaintArgs {
  clip: ClipRecord
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  audioContext: AudioContext | null
  dest: MediaStreamAudioDestinationNode | null
  onFrameProgress?: (clipElapsedMs: number) => void
}

async function paintClipToCanvas({
  clip,
  canvas,
  ctx,
  audioContext,
  dest,
  onFrameProgress,
}: PaintArgs): Promise<void> {
  const url = URL.createObjectURL(clip.blob)
  const video = document.createElement('video')
  video.src = url
  video.playsInline = true
  // Must be muted for autoplay policies on Android Chrome/Brave during export.
  // Audio is mixed separately from a decoded AudioBuffer so the stitch keeps sound.
  video.muted = true
  video.preload = 'auto'
  video.setAttribute('playsinline', 'true')
  video.setAttribute('webkit-playsinline', 'true')

  let bufferSource: AudioBufferSourceNode | null = null

  try {
    await waitForEvent(video, 'loadeddata')
    await waitForVideoDimensions(video)

    const startSec = clip.trimStartMs / 1000
    const endSec = Math.min(clip.trimEndMs, clip.durationMs) / 1000
    if (!(endSec > startSec)) return

    video.currentTime = startSec
    await waitForEvent(video, 'seeked')

    const audioBuffer =
      audioContext && dest ? await decodeClipAudio(audioContext, clip.blob) : null

    if (audioContext && dest && audioBuffer) {
      try {
        if (audioContext.state === 'suspended') {
          await audioContext.resume().catch(() => undefined)
        }
        bufferSource = audioContext.createBufferSource()
        bufferSource.buffer = audioBuffer
        bufferSource.connect(dest)
      } catch {
        bufferSource = null
      }
    }

    await video.play()

    if (bufferSource && audioContext && audioBuffer) {
      const offset = Math.min(Math.max(0, startSec), Math.max(0, audioBuffer.duration - 0.01))
      const duration = Math.min(
        Math.max(0, endSec - startSec),
        Math.max(0, audioBuffer.duration - offset),
      )
      if (duration > 0.02) {
        bufferSource.start(audioContext.currentTime, offset, duration)
      }
    }

    await new Promise<void>((resolve, reject) => {
      let raf = 0
      let lastFrameAt = performance.now()
      const draw = () => {
        const now = performance.now()
        if (video.ended || video.currentTime >= endSec - 0.04) {
          cancelAnimationFrame(raf)
          video.pause()
          resolve()
          return
        }

        // Stall watchdog: if playback never advances, abort this clip.
        if (now - lastFrameAt > 8000) {
          cancelAnimationFrame(raf)
          video.pause()
          reject(new Error('Clip playback stalled during export'))
          return
        }

        if (video.videoWidth > 0) {
          drawCover(ctx, video, canvas.width, canvas.height)
          lastFrameAt = now
        }
        onFrameProgress?.(Math.max(0, (video.currentTime - startSec) * 1000))
        raf = requestAnimationFrame(draw)
      }

      video.onerror = () => {
        cancelAnimationFrame(raf)
        reject(new Error('Failed while exporting a clip'))
      }
      raf = requestAnimationFrame(draw)
    })
  } finally {
    try {
      bufferSource?.stop()
    } catch {
      // already ended
    }
    bufferSource?.disconnect()
    URL.revokeObjectURL(url)
    video.removeAttribute('src')
    video.load()
  }
}

async function decodeClipAudio(
  audioContext: AudioContext,
  blob: Blob,
): Promise<AudioBuffer | null> {
  try {
    const bytes = await blob.arrayBuffer()
    // decodeAudioData may detach the buffer; copy so callers can reuse the blob.
    return await audioContext.decodeAudioData(bytes.slice(0))
  } catch {
    return null
  }
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  width: number,
  height: number,
): void {
  const vw = video.videoWidth || width
  const vh = video.videoHeight || height
  const scale = Math.max(width / vw, height / vh)
  const dw = vw * scale
  const dh = vh * scale
  const dx = (width - dw) / 2
  const dy = (height - dh) / 2
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(video, dx, dy, dw, dh)
}

function waitForEvent(target: HTMLMediaElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOk = () => {
      cleanup()
      resolve()
    }
    const onErr = () => {
      cleanup()
      reject(new Error(`Media event failed: ${event}`))
    }
    const cleanup = () => {
      target.removeEventListener(event, onOk)
      target.removeEventListener('error', onErr)
    }
    target.addEventListener(event, onOk, { once: true })
    target.addEventListener('error', onErr, { once: true })
  })
}

async function waitForVideoDimensions(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth > 0 && video.videoHeight > 0) return
  await new Promise<void>((resolve, reject) => {
    const started = performance.now()
    const tick = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        resolve()
        return
      }
      if (performance.now() - started > 4000) {
        reject(new Error('Clip never produced video frames'))
        return
      }
      requestAnimationFrame(tick)
    }
    tick()
  })
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Android often needs the URL alive a bit longer than desktop.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export async function shareOrDownload(
  blob: Blob,
  filename: string,
): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const type = blob.type || 'video/webm'
  const file = new File([blob], filename, { type })

  // On Android, Web Share with files is far more reliable than <a download>.
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: filename,
      })
      return 'shared'
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return 'cancelled'
      }
      // Fall through to download attempt.
    }
  }

  if (isMobileBrowser()) {
    // Last-resort mobile path: open the blob URL so the browser can hand off to the viewer/share sheet.
    const url = URL.createObjectURL(blob)
    const opened = window.open(url, '_blank', 'noopener')
    if (!opened) {
      await downloadBlob(blob, filename)
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      return 'downloaded'
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    return 'downloaded'
  }

  await downloadBlob(blob, filename)
  return 'downloaded'
}

export function downloadClipsAsSeparateFiles(clips: ClipRecord[], projectName: string): void {
  clips.forEach((clip, index) => {
    const ext = clip.mimeType.includes('mp4') ? 'mp4' : 'webm'
    const name = `${slugify(projectName)}-clip-${String(index + 1).padStart(2, '0')}.${ext}`
    void downloadBlob(clip.blob, name)
  })
}

/** Share/download a single original clip — most reliable path on mobile. */
export async function shareClipFile(
  clip: ClipRecord,
  projectName: string,
  index: number,
): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const ext = clip.mimeType.includes('mp4') ? 'mp4' : 'webm'
  const filename = `${slugify(projectName)}-clip-${String(index + 1).padStart(2, '0')}.${ext}`
  return shareOrDownload(clip.blob, filename)
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 40) || 'project'
  )
}

export function projectFilename(projectName: string, ext = 'webm'): string {
  return `${slugify(projectName)}.${ext}`
}
