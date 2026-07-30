import { loadClipVideo } from './export/shared'
import type { ClipRecord } from './types'

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
}

export async function openCameraStream(
  facing: FacingMode,
  options: OpenCameraOptions = {},
): Promise<MediaStream> {
  const withAudio = options.audio === true
  const baseConstraints: MediaTrackConstraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
  }

  // A specific lens (e.g. the rear ultra-wide) is requested by device id;
  // stale ids (permission reset, OS updates) fall back to facing mode.
  if (options.deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: withAudio,
        video: { ...baseConstraints, deviceId: { exact: options.deviceId } },
      })
    } catch {
      // Some Android HALs choke on resolution hints for auxiliary lenses —
      // retry the exact device bare before giving up on it.
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: withAudio,
          video: { deviceId: { exact: options.deviceId } },
        })
      } catch {
        // Fall through to the facing-mode request below.
      }
    }
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: withAudio,
      video: { ...baseConstraints, facingMode: { ideal: facing } },
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

interface InputDeviceWithCapabilities extends MediaDeviceInfo {
  getCapabilities?: () => MediaTrackCapabilities
}

/**
 * Rear camera devices, in enumeration order. Many Androids expose the
 * ultra-wide (and telephoto) as separate rear cameras rather than as zoom
 * below 1× on the main one — reaching them requires opening that device.
 * Labels/capabilities are only populated once camera permission is granted.
 */
export async function listRearCameras(): Promise<string[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices
      .filter((device): device is InputDeviceWithCapabilities => device.kind === 'videoinput')
      .filter((device) => {
        try {
          const facing = device.getCapabilities?.().facingMode
          if (Array.isArray(facing) && facing.length > 0) {
            return facing.includes('environment')
          }
        } catch {
          // Fall through to the label heuristic.
        }
        return /\bback\b|\brear\b|environment/i.test(device.label)
      })
      .map((device) => device.deviceId)
      .filter((id) => id.length > 0)
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

/** Grab a mic track only for the duration of a recording. */
export async function openMicrophoneTrack(): Promise<MediaStreamTrack> {
  // Camera-app audio, not voice-call audio: echoCancellation/noiseSuppression/
  // autoGainControl route the mic through the "communications" processing
  // path (especially on Android), which sounds muffled, pumpy, and narrow.
  // Real camera apps record the raw mic — so do we. Bare boolean constraint
  // values are treated as ideal, so unsupported devices still open the mic.
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
      sampleRate: { ideal: 48000 },
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
 */
export function pickRecordingMimeType(): string {
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
 * Read the real media duration of a recorded blob (handles MediaRecorder
 * WebM files that report Infinity until seeked past the end).
 */
export async function measureBlobDuration(blob: Blob, timeoutMs = 5000): Promise<number> {
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

export function isMobileBrowser(): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}

/** All iOS browsers share WebKit (and its quirks), whatever their brand. */
export function isIosBrowser(): boolean {
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return true
  // iPadOS masquerades as macOS but is the only "Mac" with touch points.
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
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

export function canShareFile(blob: Blob, filename: string): boolean {
  const file = new File([blob], filename, { type: blob.type || 'video/webm' })
  return navigator.canShare?.({ files: [file] }) === true
}

/**
 * Open the system share sheet for a file. Must be called from a user gesture
 * (Web Share requires transient activation) — never from the tail of an
 * async flow.
 */
export async function shareFile(blob: Blob, filename: string): Promise<'shared' | 'cancelled'> {
  const file = new File([blob], filename, { type: blob.type || 'video/webm' })
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
): Promise<'shared' | 'downloaded' | 'cancelled'> {
  if (canShareFile(blob, filename)) {
    try {
      return await shareFile(blob, filename)
    } catch {
      // Fall through to download attempt.
    }
  }
  await downloadBlob(blob, filename)
  return 'downloaded'
}

/**
 * Save every original clip as its own file. Downloads are spaced out so the
 * browser's multiple-download prompt has a chance to appear once instead of
 * silently dropping all but the first file.
 */
export async function downloadClipsAsSeparateFiles(
  clips: ClipRecord[],
  projectName: string,
): Promise<void> {
  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index]
    const ext = clip.mimeType.includes('mp4') ? 'mp4' : 'webm'
    const name = `${slugify(projectName)}-clip-${String(index + 1).padStart(2, '0')}.${ext}`
    await downloadBlob(clip.blob, name)
    if (index < clips.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }
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
