/** Helpers shared by the WebCodecs and realtime export engines. */

export interface LoadedClipVideo {
  video: HTMLVideoElement
  /** Real media duration in ms (resolved even for streamy MediaRecorder WebM). */
  mediaDurationMs: number
  release: () => void
}

/**
 * Load a clip blob into an off-DOM video element and resolve its real
 * duration. MediaRecorder WebM blobs report `Infinity` until you seek far
 * past the end, so that dance is handled here.
 */
export async function loadClipVideo(blob: Blob, timeoutMs = 8000): Promise<LoadedClipVideo> {
  const url = URL.createObjectURL(blob)
  const video = document.createElement('video')
  video.preload = 'auto'
  video.muted = true
  video.playsInline = true
  video.setAttribute('playsinline', 'true')

  const release = () => {
    try {
      video.pause()
    } catch {
      // already released
    }
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }

  try {
    video.src = url
    await waitForMediaEvent(video, 'loadedmetadata', timeoutMs)

    let durationSec = video.duration
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      // Force Chromium to compute the duration of a streamed WebM.
      video.currentTime = Number.MAX_SAFE_INTEGER
      await waitForCondition(
        () => Number.isFinite(video.duration) && video.duration > 0,
        timeoutMs,
      )
      durationSec = video.duration
      video.currentTime = 0
      await waitForMediaEvent(video, 'seeked', 2000).catch(() => undefined)
    }

    await waitForCondition(() => video.videoWidth > 0 && video.videoHeight > 0, timeoutMs)

    return {
      video,
      mediaDurationMs: Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : 0,
      release,
    }
  } catch (error) {
    release()
    throw error
  }
}

export function waitForMediaEvent(
  target: HTMLMediaElement,
  event: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for media "${event}"`))
    }, timeoutMs)
    const onOk = () => {
      cleanup()
      resolve()
    }
    const onErr = () => {
      cleanup()
      reject(new Error(`Media failed while waiting for "${event}"`))
    }
    const cleanup = () => {
      window.clearTimeout(timer)
      target.removeEventListener(event, onOk)
      target.removeEventListener('error', onErr)
    }
    target.addEventListener(event, onOk, { once: true })
    target.addEventListener('error', onErr, { once: true })
  })
}

export function waitForCondition(check: () => boolean, timeoutMs: number): Promise<void> {
  if (check()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const tick = () => {
      if (check()) {
        resolve()
        return
      }
      if (performance.now() - started > timeoutMs) {
        reject(new Error('Timed out preparing clip media'))
        return
      }
      requestAnimationFrame(tick)
    }
    tick()
  })
}

/**
 * Seek and wait for the frame to be ready. Resolves (never rejects) on
 * timeout because a same-position seek may not emit `seeked` everywhere.
 */
export async function seekTo(video: HTMLVideoElement, sec: number, timeoutMs = 2000): Promise<void> {
  const seeked = waitForMediaEvent(video, 'seeked', timeoutMs).catch(() => undefined)
  video.currentTime = sec
  await seeked
}

/** Draw the video into the canvas with cover fit (center crop, no bars). */
export function drawCover(
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
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(video, (width - dw) / 2, (height - dh) / 2, dw, dh)
}

/**
 * Pick output dimensions from the first clip's real pixel size: preserve its
 * aspect ratio, cap the long edge at 1280, never upscale, keep dims even.
 */
export function pickOutputSize(sourceWidth: number, sourceHeight: number): {
  width: number
  height: number
} {
  const w = sourceWidth > 0 ? sourceWidth : 720
  const h = sourceHeight > 0 ? sourceHeight : 1280
  const scale = Math.min(1, 1280 / Math.max(w, h))
  const even = (n: number) => Math.max(2, 2 * Math.round((n * scale) / 2))
  return { width: even(w), height: even(h) }
}

/** Decode a clip's audio track at the given sample rate. Null when it has none. */
export async function decodeClipAudio(
  blob: Blob,
  sampleRate = 48000,
): Promise<AudioBuffer | null> {
  try {
    const bytes = await blob.arrayBuffer()
    const ctx = new OfflineAudioContext(2, 1, sampleRate)
    return await ctx.decodeAudioData(bytes)
  } catch {
    return null
  }
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

export interface ExportResult {
  blob: Blob
  mimeType: string
  fileExtension: 'mp4' | 'webm'
}
