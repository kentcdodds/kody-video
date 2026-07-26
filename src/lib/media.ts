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

export async function openCameraStream(facing: FacingMode): Promise<MediaStream> {
  const videoConstraints: MediaTrackConstraints = {
    facingMode: { ideal: facing },
    width: { ideal: 1280 },
    height: { ideal: 720 },
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: videoConstraints,
    })
  } catch (error) {
    if (isOverconstrained(error)) {
      return navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      })
    }
    throw error
  }
}

function isOverconstrained(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'OverconstrainedError'
}

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop())
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
      // Some browsers report Infinity until a seek.
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

/**
 * Stitch clips into a single WebM using canvas captureStream + MediaRecorder.
 * Applies trim in/out by seeking each source clip.
 * Tradeoff: re-encodes video; quality depends on browser encoder; audio may be limited.
 */
export async function exportProjectAsWebm(
  clips: ClipRecord[],
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  if (clips.length === 0) {
    throw new Error('Nothing to export')
  }

  const width = 720
  const height = 1280
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas not available')

  const canvasStream = canvas.captureStream(30)
  const audioContext = new AudioContext()
  const dest = audioContext.createMediaStreamDestination()
  const mixedStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...dest.stream.getAudioTracks(),
  ])

  const mimeType = pickRecorderMimeType() || 'video/webm'
  const recorder = new MediaRecorder(mixedStream, {
    mimeType: mimeType.includes('webm') ? mimeType : undefined,
    videoBitsPerSecond: 2_500_000,
  })

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

  recorder.start(250)

  const totalMs = clips.reduce((sum, clip) => sum + effectiveDurationMs(clip), 0)
  let elapsed = 0

  try {
    for (const clip of clips) {
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
      elapsed += effectiveDurationMs(clip)
      onProgress?.(totalMs > 0 ? elapsed / totalMs : 1)
    }
  } finally {
    if (recorder.state !== 'inactive') recorder.stop()
    canvasStream.getTracks().forEach((t) => t.stop())
    await audioContext.close().catch(() => undefined)
  }

  return stopped
}

interface PaintArgs {
  clip: ClipRecord
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  audioContext: AudioContext
  dest: MediaStreamAudioDestinationNode
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
  video.muted = false
  video.preload = 'auto'

  await waitForEvent(video, 'loadeddata')

  const startSec = clip.trimStartMs / 1000
  const endSec = Math.min(clip.trimEndMs, clip.durationMs) / 1000
  video.currentTime = startSec
  await waitForEvent(video, 'seeked')

  let sourceNode: MediaElementAudioSourceNode | null = null
  try {
    sourceNode = audioContext.createMediaElementSource(video)
    sourceNode.connect(dest)
  } catch {
    // Element may already be connected in rare cases; continue video-only.
  }

  await video.play()

  await new Promise<void>((resolve, reject) => {
    let raf = 0
    const draw = () => {
      if (video.ended || video.currentTime >= endSec - 0.02) {
        cancelAnimationFrame(raf)
        video.pause()
        resolve()
        return
      }

      drawCover(ctx, video, canvas.width, canvas.height)
      onFrameProgress?.(Math.max(0, (video.currentTime - startSec) * 1000))
      raf = requestAnimationFrame(draw)
    }

    video.onerror = () => {
      cancelAnimationFrame(raf)
      reject(new Error('Failed while exporting a clip'))
    }
    raf = requestAnimationFrame(draw)
  })

  sourceNode?.disconnect()
  URL.revokeObjectURL(url)
  video.removeAttribute('src')
  video.load()
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

export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function shareOrDownload(blob: Blob, filename: string): Promise<'shared' | 'downloaded'> {
  const file = new File([blob], filename, { type: blob.type || 'video/webm' })
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: filename,
      })
      return 'shared'
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return 'downloaded'
      }
      // Fall through to download.
    }
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

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40) || 'project'
}

export function projectFilename(projectName: string, ext = 'webm'): string {
  return `${slugify(projectName)}.${ext}`
}
