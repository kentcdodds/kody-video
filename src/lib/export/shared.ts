import {
  ALL_FORMATS,
  AudioBufferSink,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  InputDisposedError,
  Mp4OutputFormat,
  Output,
  UnsupportedInputFormatError,
} from 'mediabunny'
import { reportError } from '../error-reporting'
import type { ProjectOrientation } from '../types'
import { isMediaElementFailure, MediaElementFailureError } from './media-error'

/** Helpers shared by the WebCodecs and realtime export engines. */

export interface LoadedClipVideo {
  video: HTMLVideoElement
  /** Real media duration in ms (resolved even for streamy MediaRecorder WebM). */
  mediaDurationMs: number
  release: () => void
}

/**
 * Backoff between loadClipVideo retries. Hardware decoder slots (camera,
 * editor preview, a prior failed open) often take a few hundred ms to free
 * on Android and iOS WebKit — which can report the race as
 * MEDIA_ERR_SRC_NOT_SUPPORTED even for a blob that played moments earlier.
 */
const MEDIA_LOAD_RETRY_DELAYS_MS = [200, 500, 1000, 2000]

/**
 * Attach diagnostic detail (engine, clip index, load purpose) to an error
 * on its way up — remote export failures are undebuggable without knowing
 * WHICH clip and WHICH code path rejected.
 */
export function tagExportError(error: unknown, detail: Record<string, unknown>): unknown {
  if (error && typeof error === 'object') {
    const target = error as { exportDetail?: Record<string, unknown> }
    target.exportDetail = { ...target.exportDetail, ...detail }
  }
  return error
}

/**
 * Prefer the clip's recorded MIME type when the Blob's type is missing,
 * generic, or disagrees. Safari rejects object URLs typed as
 * `application/octet-stream` with MEDIA_ERR_SRC_NOT_SUPPORTED.
 */
export function blobForPlayback(blob: Blob, mimeType?: string): Blob {
  const preferred = (mimeType || '').trim()
  if (!preferred || preferred === blob.type) return blob
  return new Blob([blob], { type: preferred })
}

/**
 * Load a clip blob into an off-DOM video element and resolve its real
 * duration. MediaRecorder WebM blobs report `Infinity` until you seek far
 * past the end, so that dance is handled here.
 *
 * Retries on media-element failure: Android/iOS often reject the first open
 * when a just-unmounted preview/camera still holds a decoder slot.
 */
export async function loadClipVideo(
  blob: Blob,
  timeoutMs = 8000,
  mimeType?: string,
): Promise<LoadedClipVideo> {
  const playable = blobForPlayback(blob, mimeType)
  let lastError: unknown
  for (let attempt = 0; attempt <= MEDIA_LOAD_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await loadClipVideoOnce(playable, timeoutMs)
    } catch (error) {
      lastError = error
      if (!isMediaElementFailure(error)) throw error
      const delay = MEDIA_LOAD_RETRY_DELAYS_MS[attempt]
      if (delay === undefined) break
      await wait(delay)
    }
  }
  throw lastError
}

async function loadClipVideoOnce(blob: Blob, timeoutMs: number): Promise<LoadedClipVideo> {
  const url = URL.createObjectURL(blob)
  const video = document.createElement('video')
  video.preload = 'auto'
  prepareExportVideoElement(video)

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
    // Attach the listener before assigning src/load so a synchronous
    // loadedmetadata cannot slip past (WebKit sometimes fires promptly for
    // already-buffered blob URLs).
    const metadataReady = waitForMediaEvent(video, 'loadedmetadata', timeoutMs)
    video.src = url
    // Explicit load() helps WebKit pick up a freshly assigned blob URL after
    // a prior media element on the same page was torn down.
    video.load()
    await metadataReady

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

/**
 * Decode a photo clip's blob for export drawing. ImageBitmap is preferred
 * (decodes off the main thread, honors EXIF orientation in every current
 * browser); the caller must close() it.
 */
export async function loadClipImage(blob: Blob): Promise<ImageBitmap> {
  const bitmap = await createImageBitmap(blob)
  if (bitmap.width <= 0 || bitmap.height <= 0) {
    bitmap.close()
    throw new Error('Could not decode photo')
  }
  return bitmap
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
      reject(new MediaElementFailureError(event, target))
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
    // Timer-based polling, not rAF: this must keep running in hidden tabs so
    // a take can finish saving after the app is backgrounded mid-recording.
    const tick = () => {
      if (check()) {
        resolve()
        return
      }
      if (performance.now() - started > timeoutMs) {
        reject(new Error('Timed out preparing clip media'))
        return
      }
      window.setTimeout(tick, 50)
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

/**
 * Autoplay-policy / Low Power Mode rejection from HTMLMediaElement.play().
 * Same DOMException name as getUserMedia permission denial — callers must
 * only use this on a play() rejection, never on a camera error.
 */
export function isAutoplayBlockedError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotAllowedError'
}

/**
 * Safari/iOS treats the muted *attribute* and playsinline flag as load-bearing
 * for muted autoplay; the JS properties alone are not always enough.
 */
export function prepareExportVideoElement(video: HTMLVideoElement): void {
  video.muted = true
  video.defaultMuted = true
  video.playsInline = true
  video.setAttribute('muted', '')
  video.setAttribute('playsinline', 'true')
  video.setAttribute('webkit-playsinline', 'true')
}

/**
 * Start muted playback for an export painter. Returns `blocked` when the
 * user agent refuses play() (iOS Low Power Mode / expired user activation)
 * so callers can scrub frames via seek instead of failing the export
 * (KODY-VIDEO-W).
 */
export async function playExportVideo(
  video: HTMLVideoElement,
): Promise<'playing' | 'blocked'> {
  prepareExportVideoElement(video)
  try {
    await video.play()
    return 'playing'
  } catch (error) {
    if (isAutoplayBlockedError(error)) return 'blocked'
    throw error
  }
}

/**
 * Soften iOS autoplay / Low Power Mode blocks for later muted export plays.
 * Must run from the export tap (same reason we unlock AudioContext): play
 * then pause a muted element while the gesture token is still alive so
 * subsequent detached muted play() calls are more likely to succeed after
 * the many awaits that precede paintSegment.
 */
export function unlockExportMediaPlayback(sourceBlob?: Blob | null): void {
  if (typeof document === 'undefined') return
  if (!sourceBlob || sourceBlob.size <= 0) return

  const video = document.createElement('video')
  prepareExportVideoElement(video)
  const objectUrl = URL.createObjectURL(sourceBlob)
  const release = () => {
    try {
      video.pause()
    } catch {
      // already released
    }
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(objectUrl)
  }

  video.preload = 'auto'
  video.src = objectUrl
  // load() during the gesture helps WebKit accept a delayed play() later.
  video.load()
  void video
    .play()
    .then(() => {
      video.pause()
      release()
    })
    .catch(() => {
      release()
    })
}

/** Draw the video into the canvas with cover fit (center crop, no bars). */
export function drawCover(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  width: number,
  height: number,
): void {
  drawCoverFrom(ctx, video, video.videoWidth || width, video.videoHeight || height, width, height)
}

/** drawCover for any drawable source (VideoFrame, canvas, video element). */
export function drawCoverFrom(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
): void {
  const vw = sourceWidth || width
  const vh = sourceHeight || height
  const scale = Math.max(width / vw, height / vh)
  const dw = vw * scale
  const dh = vh * scale
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(source, (width - dw) / 2, (height - dh) / 2, dw, dh)
}

/**
 * Pick output dimensions from the first clip's real pixel size: preserve its
 * aspect ratio, cap the long edge at 1280, never upscale, keep dims even.
 *
 * When the project carries an explicit `orientation`, the output must match
 * it regardless of what the first clip happens to be: a mismatched source
 * has its dimensions swapped (the same cover-fit draw that letterboxes
 * nothing then center-crops every frame into the rotated canvas). A square
 * source is deliberately left square — it already satisfies either
 * orientation, and inventing a non-square target would crop pixels for no
 * reason.
 */
export function pickOutputSize(
  sourceWidth: number,
  sourceHeight: number,
  orientation?: ProjectOrientation,
): {
  width: number
  height: number
} {
  let w = sourceWidth > 0 ? sourceWidth : 720
  let h = sourceHeight > 0 ? sourceHeight : 1280
  if (
    (orientation === 'landscape' && h > w) ||
    (orientation === 'portrait' && w > h)
  ) {
    ;[w, h] = [h, w]
  }
  const scale = Math.min(1, 1280 / Math.max(w, h))
  const even = (n: number) => Math.max(2, 2 * Math.round((n * scale) / 2))
  return { width: even(w), height: even(h) }
}

/** Decode a clip's audio track at the given sample rate. Null when it has none. */
let audioDecodeFailureReported = false

/** Per-export audio observations, evaluated once by reportSilentExportAudio.
 * Debugging silent exports remotely needs to know two things per clip: which
 * decode path ran, and whether the decoded audio carried any actual signal
 * (a perfect pipeline still exports silence when the mic recorded none). */
interface ClipAudioObservation {
  path: 'decoded' | 'none' | 'failed'
  peak: number
  mimeType: string
}

let audioObservations: ClipAudioObservation[] = []

/**
 * Clear per-export audio observations. By default also re-arms the once-per-
 * export decode-failure Sentry gate. Pass `retainFailureReport` when the
 * WebCodecs → realtime fallback resets mid-export so the same user action
 * cannot emit two "Clip audio decode failed" events.
 */
export function resetAudioDiagnostics(
  options: { retainFailureReport?: boolean } = {},
): void {
  audioObservations = []
  if (!options.retainFailureReport) {
    audioDecodeFailureReported = false
  }
}

/** Test-only: whether the next decode failure would call reportError. */
export function __isAudioDecodeFailureReportArmedForTests(): boolean {
  return !audioDecodeFailureReported
}

/** Near-silence floor shared by the input and output audio diagnostics. */
export const AUDIO_SILENCE_PEAK = 0.005

/**
 * Fraction of the decoded input peak the muxed output must retain before a
 * below-floor absolute peak is treated as "still present". Lossy AAC can
 * nudge a near-floor peak under {@link AUDIO_SILENCE_PEAK} without dropping
 * the track; a real encode/mux fault collapses energy to ~0.
 */
export const AUDIO_PEAK_RETENTION_RATIO = 0.25

/**
 * Decide whether a finished export's audio peak indicates an encode/mux
 * silence fault. Absolute floor first; when the output sits just under it,
 * compare against the input so near-floor encode attenuation is not a false
 * positive (Sentry KODY-VIDEO-K: input 0.0065 → output 0.0048).
 */
export function classifyOutputAudioPeak(
  inputPeak: number,
  outputPeak: number,
): 'ok' | 'silent' | 'unknown' {
  if (inputPeak < AUDIO_SILENCE_PEAK) return 'unknown'
  if (outputPeak >= AUDIO_SILENCE_PEAK) return 'ok'
  if (outputPeak >= inputPeak * AUDIO_PEAK_RETENTION_RATIO) return 'ok'
  return 'silent'
}

/** Loudest decoded input peak this export (0 when nothing decoded). */
export function decodedAudioMaxPeak(): number {
  if (audioObservations.length === 0) return 0
  return Math.max(...audioObservations.map((o) => o.peak))
}

/** Fires a single tagged Sentry report when an export's audio looks wrong —
 * every clip failed to decode, or nothing above the near-silence floor. */
export function reportSilentExportAudio(context: Record<string, unknown>): void {
  if (audioObservations.length === 0) return
  const maxPeak = Math.max(...audioObservations.map((o) => o.peak))
  const allFailed = audioObservations.every((o) => o.path === 'failed')
  if (!allFailed && maxPeak >= AUDIO_SILENCE_PEAK) return
  reportError(
    new Error(
      allFailed
        ? 'Export audio: every clip failed to decode'
        : 'Export audio: decoded clips are silent (mic likely recorded nothing)',
    ),
    'export-audio',
    {
      ...context,
      clips: audioObservations.map((o) => ({
        path: o.path,
        peak: Number(o.peak.toFixed(4)),
        mimeType: o.mimeType,
      })),
    },
  )
}

/** How long engines poll for the export-overlay canvas before falling back. */
export const PREVIEW_CANVAS_WAIT_MS = 1500

/** The export overlay mounts just after the export starts — wait briefly.
 * Encoding into the on-DOM overlay canvas (instead of a detached one) is
 * load-bearing on Safari, which renders detached canvases as black in
 * captureStream and related paths. */
export async function waitForPreviewCanvas(
  getPreviewCanvas: (() => HTMLCanvasElement | null) | undefined,
  timeoutMs = PREVIEW_CANVAS_WAIT_MS,
): Promise<HTMLCanvasElement | null> {
  if (!getPreviewCanvas) return null
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const canvas = getPreviewCanvas()
    if (canvas?.isConnected) return canvas
    if (performance.now() > deadline) return null
    await wait(50)
  }
}

/**
 * Where the encode canvas came from. `detached` is fine on Chromium but
 * black on iOS WebKit — engines must use `requireAttached` there so the
 * fallback is an on-DOM host, never an orphan element (KODY-VIDEO-Q).
 */
export type EncodeCanvasKind = 'preview' | 'attached-fallback' | 'detached'

export interface ResolvedEncodeCanvas {
  canvas: HTMLCanvasElement
  kind: EncodeCanvasKind
  /** True when the encode canvas IS the visible preview (no blit needed). */
  encodingIntoPreview: boolean
  /** Remove an attached fallback host; no-op for preview/detached. */
  release: () => void
}

/** Tiny on-DOM host: WebKit needs isConnected; keep it in the paint path
 * (off-screen 1×1) — opacity:0 / display:none can skip captureStream frames. */
function createAttachedEncodeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.setAttribute('aria-hidden', 'true')
  canvas.style.cssText =
    'position:fixed;left:-9999px;top:0;width:1px;height:1px;pointer-events:none;'
  document.body.appendChild(canvas)
  return canvas
}

/**
 * Pick the canvas the encoder draws into.
 * - `preferPreview`: wait for the export overlay (live preview + Safari-safe).
 * - `requireAttached`: never return a detached canvas (iOS WebKit).
 */
export async function resolveEncodeCanvas(options: {
  getPreviewCanvas?: () => HTMLCanvasElement | null
  preferPreview: boolean
  requireAttached: boolean
  previewTimeoutMs?: number
}): Promise<ResolvedEncodeCanvas> {
  if (options.preferPreview) {
    const preview = await waitForPreviewCanvas(
      options.getPreviewCanvas,
      options.previewTimeoutMs,
    )
    if (preview) {
      return {
        canvas: preview,
        kind: 'preview',
        encodingIntoPreview: true,
        release: () => undefined,
      }
    }
  }

  if (options.requireAttached) {
    const canvas = createAttachedEncodeCanvas()
    return {
      canvas,
      kind: 'attached-fallback',
      encodingIntoPreview: false,
      release: () => {
        canvas.remove()
      },
    }
  }

  return {
    canvas: document.createElement('canvas'),
    kind: 'detached',
    encodingIntoPreview: false,
    release: () => undefined,
  }
}

/** Video-side twin of the audio diagnostics: sampled encode-canvas luma.
 * A black exported video with no error is otherwise invisible remotely. */
let videoLumaSamples: number[] = []
let videoSampleCanvas: HTMLCanvasElement | null = null
let encodeCanvasKind: EncodeCanvasKind | null = null

export function resetVideoDiagnostics(): void {
  videoLumaSamples = []
  encodeCanvasKind = null
}

/** Record which canvas path this export used (for black-frame triage). */
export function noteEncodeCanvasKind(kind: EncodeCanvasKind): void {
  encodeCanvasKind = kind
}

/** Downsample the encode canvas to 8×8 and record the frame's mean luma. */
export function recordVideoLumaSample(source: HTMLCanvasElement): void {
  try {
    if (!videoSampleCanvas) {
      videoSampleCanvas = document.createElement('canvas')
      videoSampleCanvas.width = 8
      videoSampleCanvas.height = 8
    }
    const ctx = videoSampleCanvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    ctx.drawImage(source, 0, 0, 8, 8)
    const { data } = ctx.getImageData(0, 0, 8, 8)
    let total = 0
    for (let i = 0; i < data.length; i += 4) {
      total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    }
    videoLumaSamples.push(total / (data.length / 4))
  } catch {
    // Sampling must never break an export.
  }
}

/** One tagged Sentry report when the export's frames were all near-black. */
export function reportBlackExportVideo(context: Record<string, unknown>): void {
  if (videoLumaSamples.length < 3) return
  const maxLuma = Math.max(...videoLumaSamples)
  if (maxLuma >= 10) return
  reportError(new Error('Export video: sampled frames are all near-black'), 'export-video', {
    ...context,
    samples: videoLumaSamples.length,
    maxLuma: Number(maxLuma.toFixed(2)),
    encodeCanvas: encodeCanvasKind,
  })
}

function audioBufferPeak(buffer: AudioBuffer): number {
  let peak = 0
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
    const data = buffer.getChannelData(ch)
    const stride = Math.max(1, Math.floor(data.length / 4000))
    for (let i = 0; i < data.length; i += stride) {
      const value = Math.abs(data[i])
      if (value > peak) peak = value
    }
  }
  return peak
}

/** Cap mime diagnostics — blob.type is caller-controlled (publishable DSN). */
export function boundedAudioMimeType(mimeType: string): string {
  return mimeType.trim().slice(0, 120) || 'unknown-mime'
}

/**
 * Short, non-PII detail for remote triage when clip audio decode throws.
 * The catch used to swallow the underlying error entirely (KODY-VIDEO-P),
 * which left Seer guessing at a retired media-element path.
 */
export function audioDecodeFailureDetail(error: unknown, mimeType: string): string {
  const mime = boundedAudioMimeType(mimeType)
  if (error instanceof Error) {
    const name = error.name && error.name !== 'Error' ? error.name : ''
    const message = error.message.trim().slice(0, 120)
    const cause = name && message ? `${name}: ${message}` : name || message || 'unknown'
    return ` (${mime}; ${cause})`
  }
  const text = String(error).trim().slice(0, 120)
  return text ? ` (${mime}; ${text})` : ` (${mime})`
}

/**
 * Permanent demux/lifecycle failures — retrying only burns ~3.7s per clip.
 * WebKit's WebCodecs AudioDecoder also throws NotFoundError for AAC-in-MP4
 * even when `canDecode()` is true (KODY-VIDEO-R); that never recovers on
 * retry, so fail over to the Web Audio remux path immediately.
 */
function isNonRetryableAudioDecodeError(error: unknown): boolean {
  if (error instanceof UnsupportedInputFormatError || error instanceof InputDisposedError) {
    return true
  }
  return isWebKitAudioDecoderNotFoundError(error)
}

/** WebKit DOMException from a dead WebCodecs AudioDecoder configure/decode. */
export function isWebKitAudioDecoderNotFoundError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'NotFoundError'
  }
  return error instanceof Error && error.name === 'NotFoundError'
}

/**
 * Linear resample for export mixing. Avoids OfflineAudioContext — on iOS
 * WebKit that API has thrown NotFoundError for otherwise-valid buffers, and
 * mediabunny itself documents flaky OfflineAudioContext concatenation.
 */
export function resampleAudioBuffer(source: AudioBuffer, sampleRate: number): AudioBuffer {
  if (source.sampleRate === sampleRate) return source
  const ratio = sampleRate / source.sampleRate
  const length = Math.max(1, Math.round(source.length * ratio))
  const out = new AudioBuffer({
    length,
    sampleRate,
    numberOfChannels: source.numberOfChannels,
  })
  for (let ch = 0; ch < source.numberOfChannels; ch += 1) {
    const input = source.getChannelData(ch)
    const output = out.getChannelData(ch)
    if (input.length === 0) continue
    for (let i = 0; i < length; i += 1) {
      const srcPos = i / ratio
      const i0 = Math.min(Math.floor(srcPos), input.length - 1)
      const i1 = Math.min(i0 + 1, input.length - 1)
      const t = srcPos - i0
      output[i] = input[i0]! * (1 - t) + input[i1]! * t
    }
  }
  return out
}

/**
 * Remux the blob's audio track into an audio-only MP4 (bitstream copy when
 * the codec is already AAC; otherwise mediabunny transcodes). Safari's
 * `decodeAudioData` often refuses video/mp4 containers but accepts audio/mp4.
 */
async function remuxAudioOnlyMp4(blob: Blob): Promise<ArrayBuffer | null> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    if (!(await input.getPrimaryAudioTrack())) return null
    const target = new BufferTarget()
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target,
    })
    const conversion = await Conversion.init({
      input,
      output,
      video: { discard: true },
      showWarnings: false,
    })
    if (!conversion.isValid) return null
    await conversion.execute()
    return target.buffer ?? null
  } finally {
    input.dispose()
  }
}

async function decodeAudioDataBuffer(
  bytes: ArrayBuffer,
  sampleRate: number,
): Promise<AudioBuffer> {
  // OfflineAudioContext exposes decodeAudioData without needing a running
  // (user-gesture) AudioContext — important for peak backfill on iOS.
  const ctx = new OfflineAudioContext(1, 1, sampleRate)
  const decoded = await ctx.decodeAudioData(bytes.slice(0))
  return resampleAudioBuffer(decoded, sampleRate)
}

/**
 * Web Audio fallback when WebCodecs AudioDecoder cannot produce samples.
 * Remuxes to audio/mp4 first (iOS refuses many video/mp4 blobs), then tries
 * the original bytes for browsers that can decode audio-from-video directly.
 */
export async function decodeBlobAudioViaWebAudio(
  blob: Blob,
  sampleRate: number,
): Promise<AudioBuffer | null> {
  try {
    const remuxed = await remuxAudioOnlyMp4(blob)
    if (remuxed && remuxed.byteLength > 0) {
      try {
        return await decodeAudioDataBuffer(remuxed, sampleRate)
      } catch {
        // Remuxed bytes rejected — try the source container below.
      }
    }
  } catch {
    // Remux itself can fail on exotic codecs; fall through.
  }

  try {
    return await decodeAudioDataBuffer(await blob.arrayBuffer(), sampleRate)
  } catch {
    return null
  }
}

/**
 * Decode a blob's audio track into one AudioBuffer at the requested sample
 * rate. Primary path: mediabunny + WebCodecs AudioDecoder (fragmented MP4,
 * WebM/Opus, …). Fallback: remux audio-only MP4 + `decodeAudioData` for iOS
 * WebKit, where AudioDecoder reports support then throws NotFoundError
 * (KODY-VIDEO-R) or `canDecode()` is false on older Safari.
 *
 * Retries transient WebCodecs throws (decoder-slot races) before falling
 * back. Permanent format errors skip both retries and the fallback.
 */

export async function decodeBlobAudio(blob: Blob, sampleRate: number): Promise<AudioBuffer | null> {
  let lastError: unknown
  for (let attempt = 0; attempt <= MEDIA_LOAD_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const decoded = await decodeBlobAudioOnce(blob, sampleRate)
      if (decoded) return decoded
      // No track / WebCodecs canDecode=false — still try the Web Audio path
      // (older iOS Safari) before giving up on a silent export.
      break
    } catch (error) {
      lastError = error
      if (isNonRetryableAudioDecodeError(error)) break
      const delay = MEDIA_LOAD_RETRY_DELAYS_MS[attempt]
      if (delay === undefined) break
      await wait(delay)
    }
  }

  if (
    lastError instanceof UnsupportedInputFormatError ||
    lastError instanceof InputDisposedError
  ) {
    throw lastError
  }

  try {
    const fallback = await decodeBlobAudioViaWebAudio(blob, sampleRate)
    if (fallback) return fallback
  } catch {
    // Prefer the WebCodecs error for Sentry triage when both paths fail.
  }

  if (lastError !== undefined) throw lastError
  return null
}

async function decodeBlobAudioOnce(blob: Blob, sampleRate: number): Promise<AudioBuffer | null> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track || !(await track.canDecode())) return null

    const sink = new AudioBufferSink(track)
    const pieces: Array<{ buffer: AudioBuffer; timestamp: number }> = []
    let sourceRate = 0
    let channels = 1
    let endSec = 0
    for await (const wrapped of sink.buffers()) {
      pieces.push({ buffer: wrapped.buffer, timestamp: wrapped.timestamp })
      sourceRate = wrapped.buffer.sampleRate
      channels = Math.max(channels, wrapped.buffer.numberOfChannels)
      endSec = Math.max(endSec, wrapped.timestamp + wrapped.duration)
    }
    if (pieces.length === 0 || sourceRate <= 0 || endSec <= 0) return null

    const merged = new AudioBuffer({
      length: Math.max(1, Math.ceil(endSec * sourceRate)),
      sampleRate: sourceRate,
      numberOfChannels: channels,
    })
    // Contiguous placement: rounding each piece's timestamp independently can
    // drift ±1 sample against its neighbor, leaving one-sample overlaps/gaps
    // (audible as faint crackle). Snap to the running end when they agree.
    let runningOffset = 0
    for (const piece of pieces) {
      const computed = Math.round(piece.timestamp * sourceRate)
      const offset = Math.abs(computed - runningOffset) <= 2 ? runningOffset : computed
      for (let ch = 0; ch < channels; ch += 1) {
        const sourceChannel = Math.min(ch, piece.buffer.numberOfChannels - 1)
        const data = piece.buffer.getChannelData(sourceChannel)
        const available = merged.length - offset
        if (available <= 0) continue
        merged.copyToChannel(available < data.length ? data.subarray(0, available) : data, ch, offset)
      }
      // Clamp to capacity: an offset past the end must not inflate the
      // running position and pull later in-range pieces past it via the snap.
      runningOffset = Math.min(offset + piece.buffer.length, merged.length)
    }
    return resampleAudioBuffer(merged, sampleRate)
  } finally {
    // Free demuxer + any WebCodecs AudioDecoder the sink still holds —
    // iOS in particular runs out of decoder slots when Inputs accumulate
    // across clip-peak backfill, preview normalize, and export.
    input.dispose()
  }
}

/**
 * Decode the project's background-audio track for export mixing. Never
 * contributes to the per-clip silence diagnostics — a loud music bed must
 * not mask dead-mic clips (and a broken music decode must not fail the
 * export, just export without music).
 */
export async function decodeBackgroundAudio(
  blob: Blob,
  sampleRate = 48000,
): Promise<AudioBuffer | null> {
  try {
    return await decodeBlobAudio(blob, sampleRate)
  } catch {
    reportError(new Error('Background audio decode failed — exporting without music'), 'export-audio', {
      mimeType: blob.type,
    })
    return null
  }
}

export async function decodeClipAudio(
  blob: Blob,
  sampleRate = 48000,
): Promise<AudioBuffer | null> {
  try {
    const mimeType = boundedAudioMimeType(blob.type)
    const decoded = await decodeBlobAudio(blob, sampleRate)
    if (decoded) {
      audioObservations.push({
        path: 'decoded',
        peak: audioBufferPeak(decoded),
        mimeType,
      })
      return decoded
    }
    audioObservations.push({ path: 'none', peak: 0, mimeType })
    return null
  } catch (error) {
    const mimeType = boundedAudioMimeType(blob.type)
    audioObservations.push({ path: 'failed', peak: 0, mimeType })
    if (!audioDecodeFailureReported) {
      audioDecodeFailureReported = true
      reportError(
        new Error(
          `Clip audio decode failed — export audio will be silent${audioDecodeFailureDetail(error, mimeType)}`,
          { cause: error },
        ),
        'export-audio',
        {
          mimeType,
          cause: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : String(error).slice(0, 200),
        },
      )
    }
    return null
  }
}

/**
 * Peak of a finished export's audio track, for output-side verification —
 * a silent MUX (e.g. an empty AAC decoder config) produces no error at any
 * stage, so the only way to catch it is decoding what was actually written.
 * Returns null when the output can't be decoded here (verification unknown,
 * not proof of silence). Never pushes per-clip observations.
 */
export interface BlobAudioMeasurement {
  peak: number | null
  /** Why the peak is unknown, when it is (for remote diagnosis). */
  failure?: string
}

export async function measureBlobAudioPeak(
  blob: Blob,
  sampleRate = 48000,
): Promise<BlobAudioMeasurement> {
  // Whole-file decode: keep memory bounded on long projects.
  if (blob.size > 120 * 1024 * 1024) return { peak: null, failure: 'too large to verify' }
  try {
    const decoded = await decodeBlobAudio(blob, sampleRate)
    if (decoded) return { peak: audioBufferPeak(decoded) }
    return { peak: null, failure: 'no decodable audio track' }
  } catch (error) {
    return { peak: null, failure: String(error).slice(0, 160) }
  }
}

/**
 * Load the mark stamped onto exported frames (unless the user purchased the
 * watermark removal). Best-effort: a missing asset must never fail an export.
 */
export function loadWatermarkImage(): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = '/pwa-192.png'
  })
}

/** The domain shown under the watermark mark. */
export function watermarkDomain(): string {
  const host = typeof location !== 'undefined' ? location.hostname : ''
  // Dev servers and IPs shouldn't end up stamped on anyone's video.
  if (!host || host === 'localhost' || /^[\d.]+$/.test(host)) {
    return 'kody.video'
  }
  return host
}

/** Geometry for the stacked mark-above-domain watermark in the bottom-right. */
export function watermarkLayout(
  width: number,
  height: number,
  textWidth: number,
): {
  size: number
  fontSize: number
  radius: number
  markX: number
  markY: number
  textX: number
  textY: number
} {
  const size = Math.round(Math.min(width, height) * 0.11)
  const margin = Math.round(size * 0.35)
  const fontSize = Math.max(10, Math.round(size * 0.38))
  const gap = Math.round(size * 0.14)
  const stackWidth = Math.max(size, textWidth)
  const right = width - margin
  const bottom = height - margin
  // Right-align the wider of mark/text; center the narrower on that axis.
  const markX = Math.round(right - stackWidth / 2 - size / 2)
  const markY = bottom - size - gap - fontSize
  return {
    size,
    fontSize,
    radius: Math.round(size * 0.22),
    markX,
    markY,
    textX: markX + size / 2,
    textY: markY + size + gap + fontSize / 2,
  }
}

/** Stamp the Kody Video mark above the domain in the bottom-right corner. */
export function drawWatermark(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number,
): void {
  const domain = watermarkDomain()
  const sizeProbe = Math.round(Math.min(width, height) * 0.11)
  const fontSizeProbe = Math.max(10, Math.round(sizeProbe * 0.38))

  ctx.save()
  ctx.font = `600 ${fontSizeProbe}px 'DM Sans', system-ui, sans-serif`
  const { size, fontSize, radius, markX, markY, textX, textY } = watermarkLayout(
    width,
    height,
    ctx.measureText(domain).width,
  )

  ctx.globalAlpha = 0.72

  ctx.save()
  ctx.beginPath()
  ctx.roundRect(markX, markY, size, size, radius)
  ctx.clip()
  ctx.drawImage(image, markX, markY, size, size)
  ctx.restore()

  ctx.font = `600 ${fontSize}px 'DM Sans', system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#fff'
  // Soft drop under the domain so it stays readable on bright frames.
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)'
  ctx.shadowBlur = Math.max(2, Math.round(size * 0.05))
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = Math.max(1, Math.round(size * 0.035))
  ctx.fillText(domain, textX, textY)

  ctx.restore()
}

/** How often the engines mirror an encoded frame to the UI preview canvas. */
export const PREVIEW_EVERY_N_FRAMES = 10

/** Preview updates are cosmetic — ~5fps wall time is plenty. */
export const PREVIEW_INTERVAL_MS = 200

/** Keep the mirrored preview cheap: cap its long edge well below encode size. */
const PREVIEW_MAX_EDGE = 480

/** Mirror the engine's work canvas onto the visible preview canvas,
 * downscaled — the preview shows progress, not pixels. */
export function blitPreview(
  source: HTMLCanvasElement,
  target: HTMLCanvasElement | null | undefined,
): void {
  if (!target) return
  const scale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(source.width, source.height, 1))
  const width = Math.max(2, Math.round(source.width * scale))
  const height = Math.max(2, Math.round(source.height * scale))
  if (target.width !== width || target.height !== height) {
    target.width = width
    target.height = height
  }
  target.getContext('2d')?.drawImage(source, 0, 0, width, height)
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

export type ExportEngine = 'webcodecs' | 'realtime'

export interface ExportResult {
  blob: Blob
  mimeType: string
  fileExtension: 'mp4' | 'webm'
  /** True only when this file actually contains clip-location metadata. */
  locationIncluded: boolean
  /** Which stitcher produced this file. Omitted on recovered cache hits. */
  engine?: ExportEngine
  /** Name of the OPFS exports-directory file this export streamed into. */
  opfsName?: string
  /** True when `blob` is exactly the bytes of the `opfsName` file (false
   * when metadata injection produced a new in-memory blob). */
  opfsBacked?: boolean
}
