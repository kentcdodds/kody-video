import { clipDownloadFilename } from './clip-facts'
import { isMobileBrowser } from './platform'
import type { ClipRecord } from './types'
import { captureVideoConstraints } from './video-quality'

export { isIosBrowser, isMobileBrowser } from './platform'

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
  /** Open a specific camera (rear lens switching); falls back to facing. */
  deviceId?: string
  /** Record from a specific microphone (audio input chooser). Only applies
   * when audio is requested; a stale id rejects the whole call, so callers
   * retry without it (see camera.ts). */
  audioDeviceId?: string
}

export async function openCameraStream(
  facing: FacingMode,
  options: OpenCameraOptions = {},
): Promise<MediaStream> {
  const audio: MediaStreamConstraints['audio'] =
    options.audio === true
      ? options.audioDeviceId
        ? { deviceId: { exact: options.audioDeviceId } }
        : true
      : false
  const baseConstraints: MediaTrackConstraints = captureVideoConstraints()

  // A specific lens (e.g. the rear ultra-wide) is requested by device id;
  // stale ids (permission reset, OS updates) fall back to facing mode.
  if (options.deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio,
        video: { ...baseConstraints, deviceId: { exact: options.deviceId } },
      })
    } catch {
      // Some Android HALs choke on resolution hints for auxiliary lenses —
      // retry the exact device bare before giving up on it.
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio,
          video: { deviceId: { exact: options.deviceId } },
        })
      } catch {
        // Fall through to the facing-mode request below.
      }
    }
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio,
      video: { ...baseConstraints, facingMode: { ideal: facing } },
    })
  } catch (error) {
    if (isOverconstrained(error)) {
      return navigator.mediaDevices.getUserMedia({
        audio,
        video: true,
      })
    }
    throw error
  }
}

interface InputDeviceWithCapabilities extends MediaDeviceInfo {
  getCapabilities?: () => MediaTrackCapabilities
}

/**
 * Rear camera devices, in enumeration order. Many Androids expose the
 * ultra-wide (and telephoto) as separate rear cameras rather than as zoom
 * below 1× on the main one — reaching them requires opening that device.
 * Labels/capabilities are only populated once camera permission is granted.
 */
function deviceFacing(device: InputDeviceWithCapabilities): string[] {
  try {
    const facing = device.getCapabilities?.().facingMode
    return Array.isArray(facing) ? facing : []
  } catch {
    return []
  }
}

function looksRear(device: InputDeviceWithCapabilities): boolean {
  const facing = deviceFacing(device)
  if (facing.length > 0) return facing.includes('environment')
  return /\bback\b|\brear\b|environment/i.test(device.label)
}

function looksFront(device: InputDeviceWithCapabilities): boolean {
  const facing = deviceFacing(device)
  if (facing.length > 0) return facing.includes('user')
  return /\bfront\b|\buser\b|selfie/i.test(device.label)
}

export async function listRearCameras(): Promise<string[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const videos = devices.filter(
      (device): device is InputDeviceWithCapabilities => device.kind === 'videoinput',
    )
    let rear = videos.filter(looksRear)
    // Some Chrome/OS builds label lenses without any facing hint ("Camera
    // 0") and report no facingMode capability. When the positive heuristics
    // find NOTHING but at least one device is identifiably front-facing,
    // treat the rest as rear — better than hiding the lens switcher on
    // phones that clearly have rear cameras.
    if (rear.length === 0) {
      const fronts = videos.filter(looksFront)
      if (fronts.length > 0 && fronts.length < videos.length) {
        rear = videos.filter((device) => !looksFront(device))
      }
    }
    return rear.map((device) => device.deviceId).filter((id) => id.length > 0)
  } catch {
    return []
  }
}

/**
 * iOS exposes every physical rear lens AND virtual composites ("Back Dual
 * Wide Camera", "Back Triple Camera") as separate devices — six on recent
 * iPhones. The composites hand lens switching to the OS: one device whose
 * zoom constraint spans 0.5× to max seamlessly, exactly like the native
 * camera app. Prefer them; cycling raw devices (the Android pattern) is
 * confusing there and records at surprising resolutions. Labels are only
 * populated once camera permission is granted; undefined falls back to the
 * default facing-mode camera.
 */
export async function preferredIosRearCameraId(): Promise<string | undefined> {
  if (!navigator.mediaDevices?.enumerateDevices) return undefined
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const rear = devices.filter(
      (device) => device.kind === 'videoinput' && /\bback\b/i.test(device.label),
    )
    const byPreference = [
      /back triple camera/i,
      /back dual wide camera/i,
      /back dual camera/i,
      /^back camera$/i,
    ]
    for (const pattern of byPreference) {
      const match = rear.find((device) => pattern.test(device.label))
      if (match?.deviceId) return match.deviceId
    }
  } catch {
    // Fall through to the default camera.
  }
  return undefined
}

export interface OpenMicrophoneOptions {
  /** Record from a specific microphone (audio input chooser); a stale or
   * unplugged id falls back to the system default. */
  deviceId?: string
}

/** Grab a mic track only for the duration of a recording. */
export async function openMicrophoneTrack(
  options: OpenMicrophoneOptions = {},
): Promise<MediaStreamTrack> {
  // Camera-app audio, not voice-call audio: echoCancellation/noiseSuppression/
  // autoGainControl route the mic through the "communications" processing
  // path (especially on Android), which sounds muffled, pumpy, and narrow.
  // Real camera apps record the raw mic — so do we. Bare boolean constraint
  // values are treated as ideal, so unsupported devices still open the mic.
  const baseAudio: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: 2 },
    sampleRate: { ideal: 48000 },
  }
  const open = (audio: MediaTrackConstraints) =>
    navigator.mediaDevices.getUserMedia({ audio, video: false })
  let mic: MediaStream
  if (options.deviceId) {
    try {
      mic = await open({ ...baseAudio, deviceId: { exact: options.deviceId } })
    } catch {
      // Stale/unplugged chosen mic — the take records from the default mic
      // rather than failing outright.
      mic = await open(baseAudio)
    }
  } else {
    mic = await open(baseAudio)
  }
  const track = mic.getAudioTracks()[0]
  if (!track) {
    mic.getTracks().forEach((t) => t.stop())
    throw new Error('No microphone track available')
  }
  return track
}

/**
 * Ask for microphone permission once, up front, and release the track
 * immediately (idle stays mic-free so Android voice-to-text keeps working).
 *
 * Requesting the mic only mid-gesture — while the user is already holding to
 * record with a live camera — gets silently auto-denied by some browsers
 * (Brave on Android never even shows the prompt, so the site's settings have
 * no microphone entry to flip). Priming at camera startup shows a normal
 * prompt at a normal moment; later per-take requests then resolve silently.
 */
/** Permission-state lookup only — never prompts, never opens a track. */
export async function queryMicrophonePermission(): Promise<'granted' | 'denied' | 'unknown'> {
  try {
    const status = await navigator.permissions.query({
      name: 'microphone' as PermissionName,
    })
    if (status.state === 'granted') return 'granted'
    if (status.state === 'denied') return 'denied'
  } catch {
    // Permission query unsupported.
  }
  return 'unknown'
}

export async function primeMicrophonePermission(): Promise<'granted' | 'denied' | 'unknown'> {
  try {
    const status = await navigator.permissions.query({
      name: 'microphone' as PermissionName,
    })
    if (status.state === 'granted') return 'granted'
    // A persisted denial can't prompt again — asking would fail silently.
    if (status.state === 'denied') return 'denied'
  } catch {
    // Permission query unsupported — fall through and prompt directly.
  }
  try {
    const track = await openMicrophoneTrack()
    track.stop()
    return 'granted'
  } catch {
    // Distinguish a persisted denial from a dismissed/interrupted prompt
    // (e.g. the app was backgrounded mid-prompt): only the former is final.
    try {
      const status = await navigator.permissions.query({
        name: 'microphone' as PermissionName,
      })
      return status.state === 'denied' ? 'denied' : 'unknown'
    } catch {
      return 'denied'
    }
  }
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

/**
 * Mime preference for live capture. On phones, H.264 is typically the only
 * hardware-accelerated encoder — recording VP9 in software is what makes the
 * camera preview and the saved clip drop frames — so prefer it there.
 * Desktops have plenty of headroom, so prefer WebM for broad compatibility.
 *
 * The answer is static per browser session, so it's probed once and cached:
 * this runs inside the pointerdown that starts every take, and each
 * isTypeSupported call crosses into the platform media stack.
 */
let cachedRecordingMimeType: string | null = null

export function pickRecordingMimeType(): string {
  if (cachedRecordingMimeType !== null) return cachedRecordingMimeType
  cachedRecordingMimeType = probeRecordingMimeType()
  return cachedRecordingMimeType
}

/** Test-only: clear the cached probe so each Vitest case re-probes. */
export function resetRecordingMimeTypeForTests(): void {
  cachedRecordingMimeType = null
}

function probeRecordingMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  const mobile = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ]
  const desktop = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=h264,opus',
    'video/webm',
    'video/mp4',
  ]
  for (const type of isMobileBrowser() ? mobile : desktop) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return ''
}

/**
 * Prefetch the demux module measureBlobDuration needs. Without this, the
 * FIRST take's stop pays the mediabunny chunk fetch + parse on the main
 * thread while the camera preview is live — visible as post-take jank.
 * Called from an idle moment on the record screen; failures just mean the
 * first measurement pays the import lazily as before.
 */
export function warmDurationProbe(): void {
  void import('mediabunny').catch(() => undefined)
}

/**
 * Read the real media duration of a recorded blob (handles MediaRecorder
 * WebM files that report Infinity until seeked past the end).
 */
export async function measureBlobDuration(blob: Blob, timeoutMs = 5000): Promise<number> {
  // Demux first: parsing the container needs no <video> element and no
  // hardware decoder. Opening a decoder right after a take — while the
  // camera preview is live — blanks the preview on many Androids (the
  // post-take black flash), and it's slower besides. Deadline-guarded so a
  // malformed blob can't hang the parse past the caller's budget.
  //
  // Dynamic import: mediabunny is large and only needed after a take /
  // during export. Keeping it out of the home-shell graph is what makes
  // first paint cheap.
  try {
    const { ALL_FORMATS, BlobSource, Input } = await import('mediabunny')
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
    const seconds = await Promise.race([
      input.computeDuration(),
      new Promise<number>((_, reject) => {
        window.setTimeout(() => reject(new Error('Demux duration timed out')), timeoutMs)
      }),
    ])
    if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000)
  } catch {
    // Unparseable container — let the element path judge it.
  }
  const { loadClipVideo } = await import('./export/shared')
  const loaded = await loadClipVideo(blob, timeoutMs)
  try {
    return loaded.mediaDurationMs
  } finally {
    loaded.release()
  }
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
 * Wrap bytes as a named File. `lastModified` is the only timestamp the File
 * API exposes — Synology Photos (and many NAS/photo libraries) sort by the
 * filesystem created/modified times, which Web Share copies from this field.
 * Created and updated become the same instant when the OS first writes the
 * file. Invalid stamps are omitted so the browser defaults to now.
 */
export function fileFromBlob(blob: Blob, filename: string, lastModified?: number): File {
  const options: FilePropertyBag = { type: blob.type || 'video/webm' }
  if (typeof lastModified === 'number' && Number.isFinite(lastModified) && lastModified > 0) {
    options.lastModified = lastModified
  }
  return new File([blob], filename, options)
}

export async function downloadBlob(
  blob: Blob,
  filename: string,
  lastModified?: number,
): Promise<void> {
  const url = URL.createObjectURL(fileFromBlob(blob, filename, lastModified))
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

export function canShareFile(blob: Blob, filename: string, lastModified?: number): boolean {
  const file = fileFromBlob(blob, filename, lastModified)
  return navigator.canShare?.({ files: [file] }) === true
}

/**
 * Open the system share sheet for a file. Must be called from a user gesture
 * (Web Share requires transient activation) — never from the tail of an
 * async flow.
 */
export async function shareFile(
  blob: Blob,
  filename: string,
  lastModified?: number,
): Promise<'shared' | 'cancelled'> {
  const file = fileFromBlob(blob, filename, lastModified)
  try {
    await navigator.share({ files: [file], title: filename })
    return 'shared'
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return 'cancelled'
    }
    throw error
  }
}

export async function shareOrDownload(
  blob: Blob,
  filename: string,
  lastModified?: number,
): Promise<'shared' | 'downloaded' | 'cancelled'> {
  if (canShareFile(blob, filename, lastModified)) {
    try {
      return await shareFile(blob, filename, lastModified)
    } catch {
      // Fall through to download attempt.
    }
  }
  await downloadBlob(blob, filename, lastModified)
  return 'downloaded'
}

/** Share/download a single original clip — most reliable path on mobile. */
export async function shareClipFile(
  clip: ClipRecord,
  projectName: string,
  index: number,
): Promise<'shared' | 'downloaded' | 'cancelled'> {
  return shareOrDownload(
    clip.blob,
    clipDownloadFilename(projectName, index, clip.mimeType),
    clip.createdAt,
  )
}

/** Save a single clip to the device (no share sheet). */
export async function downloadClipFile(
  clip: ClipRecord,
  projectName: string,
  index: number,
): Promise<void> {
  await downloadBlob(
    clip.blob,
    clipDownloadFilename(projectName, index, clip.mimeType),
    clip.createdAt,
  )
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
