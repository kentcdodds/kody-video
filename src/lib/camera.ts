import { engageRecordAudioSession, releaseRecordAudioSession } from './audio-session'
import {
  canFlipCamera,
  listRearCameras,
  openCameraStream,
  openMicrophoneTrack,
  preferredIosRearCameraId,
  primeMicrophonePermission,
  queryCameraPermission,
  queryMicrophonePermission,
  stopAudioTracks,
  stopStream,
  type CameraPermissionState,
  type FacingMode,
} from './media'
import { isIosBrowser } from './platform'

/**
 * iOS Safari is known to deliver muted (silent-but-live) audio tracks when
 * the mic and camera come from separate getUserMedia calls — the exact
 * two-call pattern the app uses elsewhere (video-only preview, mic per-take,
 * for Android's voice-to-text). On iOS the mic is acquired WITH the camera
 * in one combined call and lives as long as the preview, like a native
 * camera app. Backgrounding still releases everything.
 */
const HOLD_MIC_WITH_CAMERA = typeof navigator !== 'undefined' && isIosBrowser()

/** On iOS, camera + mic in one call (see HOLD_MIC_WITH_CAMERA); a combined
 * failure falls back to video-only so a mic-denied user still gets a
 * preview. Elsewhere always video-only. */
async function openCombinedOrVideoStream(
  facing: FacingMode,
  deviceId: string | undefined,
): Promise<MediaStream> {
  if (HOLD_MIC_WITH_CAMERA) {
    try {
      return await openCameraStream(facing, { audio: true, deviceId })
    } catch {
      // Fall through to video-only below.
    }
  }
  return openCameraStream(facing, { audio: false, deviceId })
}

/** Remembered rear lens (e.g. the ultra-wide) across sessions. */
const REAR_LENS_STORAGE_KEY = 'kodyVideo.rearLens'

interface RememberedLens {
  id: string
  /** Position in enumeration order — device ids rotate when the browser
   * clears site data, but the lens order on a given phone is stable. */
  index: number
}

function rememberedRearLens(): RememberedLens | null {
  try {
    const raw = localStorage.getItem(REAR_LENS_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<RememberedLens>
    if (typeof parsed.id !== 'string' || typeof parsed.index !== 'number') return null
    return { id: parsed.id, index: parsed.index }
  } catch {
    return null
  }
}

function rememberRearLens(lens: RememberedLens | null): void {
  try {
    if (lens) localStorage.setItem(REAR_LENS_STORAGE_KEY, JSON.stringify(lens))
    else localStorage.removeItem(REAR_LENS_STORAGE_KEY)
  } catch {
    // Storage unavailable (private mode) — lens choice just won't persist.
  }
}

/** Resolve a remembered lens against the current enumeration: exact id when
 * still valid, otherwise the same position, otherwise nothing. On iOS the
 * lens choice belongs to the OS instead (see preferredIosRearCameraId) —
 * the virtual composite camera covers all lenses through zoom, and any
 * remembered raw lens from before is ignored. */
async function resolveRearLens(): Promise<string | undefined> {
  if (isIosBrowser()) return preferredIosRearCameraId()
  const remembered = rememberedRearLens()
  if (!remembered) return undefined
  const lenses = await listRearCameras()
  if (lenses.includes(remembered.id)) return remembered.id
  return lenses[remembered.index]
}

export interface CameraZoomRange {
  min: number
  max: number
  step: number
  value: number
}

interface ZoomCapability {
  min?: number
  max?: number
  step?: number
}

interface ExtendedCapabilities extends MediaTrackCapabilities {
  zoom?: ZoomCapability
  torch?: boolean
}

interface ExtendedSettings extends MediaTrackSettings {
  zoom?: number
}

export interface Camera {
  stream: MediaStream | null
  facing: FacingMode
  permission: CameraPermissionState
  canFlip: boolean
  error: string | null
  isReady: boolean
  /** Zoom capability of the active camera, when the device exposes one. */
  zoom: CameraZoomRange | null
  torchAvailable: boolean
  torchOn: boolean
  /** Mic permission state discovered by the startup priming prompt. */
  micPermission: 'granted' | 'denied' | 'unknown'
  /** Number of rear camera devices (ultra-wide/tele are often separate). */
  rearLensCount: number
  /** Index of the active rear lens, when facing the environment. */
  rearLensIndex: number
  /** Attach the preview element (from a `ref()` mixin); starts the camera. */
  attachVideo: (element: HTMLVideoElement, signal: AbortSignal) => void
  /** Cycle to the next rear lens (no-op while facing the user). */
  switchRearLens: () => Promise<void>
  start: () => Promise<void>
  flip: () => Promise<void>
  stop: () => void
  setZoom: (value: number) => void
  setTorch: (on: boolean) => Promise<void>
  enableMic: () => Promise<void>
  releaseMic: () => void
  getStream: () => MediaStream | null
  /** The live preview element — for zero-cost frame capture at take end. */
  getVideoElement: () => HTMLVideoElement | null
  getZoom: () => CameraZoomRange | null
}

/**
 * Camera lifecycle is event/ref-driven:
 * - attachVideo (via a `ref()` mixin) attaches/detaches the stream and starts
 *   capture when the preview mounts; its abort signal stops the camera.
 * - Preview is video-only so Android OS voice-to-text can keep the mic;
 *   enableMic/releaseMic attach a mic track only while recording.
 * - Except iOS: mic comes with the camera in one combined call and stays for
 *   the preview's lifetime (see HOLD_MIC_WITH_CAMERA).
 *
 * State lives as plain fields; `notify` asks the owning component to rerender.
 */
export function createCamera(notify: () => void): Camera {
  let videoEl: HTMLVideoElement | null = null
  /** Facing intent — updated before the async open; `camera.facing` (which
   * drives the preview's mirror transform) only flips once the new stream is
   * in hand, so mirror and feed swap together. */
  let facingIntent: FacingMode = 'environment'
  let startInFlight: Promise<void> | null = null
  let micInFlight: Promise<void> | null = null
  let micPrimed = false
  let rearLenses: string[] = []
  let lensSwitchInFlight = false
  /** Bumped by stop(): async opens started before a stop must not adopt. */
  let cameraEpoch = 0
  let zoomNotifyTimer = 0

  const camera: Camera = {
    stream: null,
    facing: 'environment',
    permission: { status: 'unknown' },
    canFlip: false,
    error: null,
    isReady: false,
    zoom: null,
    torchAvailable: false,
    torchOn: false,
    micPermission: 'unknown',
    rearLensCount: 0,
    rearLensIndex: 0,
    attachVideo,
    switchRearLens,
    start,
    flip,
    stop,
    setZoom,
    setTorch,
    enableMic,
    releaseMic,
    getStream: () => camera.stream,
    getVideoElement: () => videoEl,
    getZoom: () => camera.zoom,
  }

  function setZoomRange(next: CameraZoomRange | null): void {
    window.clearTimeout(zoomNotifyTimer)
    zoomNotifyTimer = 0
    camera.zoom = next
  }

  function attachToVideo(next: MediaStream): void {
    if (!videoEl) return
    videoEl.srcObject = next
    void videoEl.play().catch(() => undefined)
  }

  function readTrackCapabilities(next: MediaStream): void {
    const track = next.getVideoTracks()[0]
    if (!track || typeof track.getCapabilities !== 'function') {
      setZoomRange(null)
      camera.torchAvailable = false
      camera.torchOn = false
      return
    }
    try {
      const caps = track.getCapabilities() as ExtendedCapabilities
      if (caps.zoom && typeof caps.zoom.min === 'number' && typeof caps.zoom.max === 'number') {
        const settings = track.getSettings() as ExtendedSettings
        setZoomRange({
          min: caps.zoom.min,
          max: caps.zoom.max,
          step: caps.zoom.step && caps.zoom.step > 0 ? caps.zoom.step : 0.1,
          value: typeof settings.zoom === 'number' ? settings.zoom : caps.zoom.min,
        })
      } else {
        setZoomRange(null)
      }
      camera.torchAvailable = caps.torch === true
      camera.torchOn = false
    } catch {
      setZoomRange(null)
      camera.torchAvailable = false
      camera.torchOn = false
    }
  }

  function replaceStream(next: MediaStream): void {
    const hadMic = (camera.stream?.getAudioTracks().length ?? 0) > 0
    stopStream(camera.stream)
    camera.stream = next
    attachToVideo(next)
    readTrackCapabilities(next)
    // iOS: every (re)open is a combined request, so the adopted stream's
    // audio presence is the freshest mic-permission signal — including
    // after flips and lens switches. A missing track is NOT proof of a
    // denial though (the combined open also falls back on transient
    // failures) — only the Permissions API may claim "blocked".
    if (HOLD_MIC_WITH_CAMERA) {
      if (next.getAudioTracks().length > 0) {
        camera.micPermission = 'granted'
        // External mics (DJI transmitters, AirPods, wired headsets): iOS
        // only routes capture to them after this post-grant audio-session
        // kick — see audio-session.ts. Must run AFTER getUserMedia resolved.
        engageRecordAudioSession()
      } else {
        // A combined reopen can fall back to video-only (mic mid-flip
        // failure) — a sticky play-and-record session with no mic held
        // would degrade playback until the camera fully stops.
        if (hadMic) releaseRecordAudioSession()
        void queryMicrophonePermission().then((state) => {
          camera.micPermission = state
          notify()
        })
      }
    }
    camera.isReady = true
    notify()
  }

  /** Discover rear lenses and locate the active one (post-permission only).
   * Not on iOS: the OS handles lens switching through the virtual composite
   * camera's zoom range, and offering six raw devices (physical lenses plus
   * composites) as a cycling chip is confusing noise there. */
  async function syncRearLenses(active: MediaStream): Promise<void> {
    if (facingIntent !== 'environment' || isIosBrowser()) {
      rearLenses = []
      camera.rearLensCount = 0
      camera.rearLensIndex = 0
      notify()
      return
    }
    const lenses = await listRearCameras()
    // A flip/stop/switch may have replaced the stream while enumerating —
    // stale results must not clobber the newer call's state.
    if (camera.stream !== active || facingIntent !== 'environment') return
    rearLenses = lenses
    camera.rearLensCount = lenses.length
    const activeId = active.getVideoTracks()[0]?.getSettings().deviceId ?? ''
    const index = lenses.indexOf(activeId)
    camera.rearLensIndex = index >= 0 ? index : 0
    notify()

    // Seamless multi-lens discovery: a rear lens whose zoom range reaches
    // below 1× is Android's logical multi-camera — the HAL hands off
    // between physical lenses (ultra-wide/wide/tele) as zoom crosses their
    // boundaries, native-camera style, even mid-recording. Lock onto it as
    // the remembered lens so every future session opens it directly.
    // A still-valid manual chip choice is never displaced from here: opens
    // land in this path incidentally too (getUserMedia fallbacks), and the
    // user's explicit pick must survive those. The chip's own switch
    // handler re-locks the logical lens when the user returns to it.
    const zoomRange = camera.zoom
    if (zoomRange && zoomRange.min < 1 && activeId && index >= 0) {
      const remembered = rememberedRearLens()
      const rememberedValid = remembered !== null && lenses.includes(remembered.id)
      if (!rememberedValid || remembered.id === activeId) {
        rememberRearLens({ id: activeId, index })
      }
    }
  }

  async function start(): Promise<void> {
    if (startInFlight) {
      await startInFlight
      return
    }

    const run = (async () => {
      camera.error = null
      // A stop() while any await below is in flight must win: a stream
      // adopted after stop() would keep the camera (and OS privacy
      // indicator) live behind an unmounted preview.
      const epoch = cameraEpoch
      const perm = await queryCameraPermission()
      if (cameraEpoch !== epoch) return
      camera.permission = perm
      notify()
      if (perm.status === 'unsupported') {
        camera.error = perm.message ?? 'Camera unsupported'
        notify()
        return
      }

      try {
        const rememberedLens =
          facingIntent === 'environment' ? await resolveRearLens() : undefined
        let next = await openCombinedOrVideoStream(facingIntent, rememberedLens)
        if (cameraEpoch !== epoch) {
          stopStream(next)
          return
        }
        camera.permission = { status: 'granted' }
        // iOS first run: device labels are empty before the permission grant,
        // so the preferred multi-lens camera can't be resolved until now.
        // Re-resolve and reopen once so 0.5× works from the very first
        // session, not just after a restart.
        if (isIosBrowser() && !rememberedLens && facingIntent === 'environment') {
          const preferred = await preferredIosRearCameraId()
          const activeId = next.getVideoTracks()[0]?.getSettings().deviceId
          if (preferred && preferred !== activeId) {
            const epoch = cameraEpoch
            // iOS camera access is exclusive — release before reopening.
            stopStream(next)
            const reopened = await openCombinedOrVideoStream(facingIntent, preferred)
            if (cameraEpoch !== epoch) {
              stopStream(reopened)
              return
            }
            next = reopened
          }
        }
        replaceStream(next)
        camera.canFlip = await canFlipCamera()
        notify()
        void syncRearLenses(next)
        // Mic permission priming (see primeMicrophonePermission): asking
        // mid-hold is silently denied by some browsers (Brave/Android never
        // shows the prompt). Prompt now, at a normal moment. The claim is
        // released when the outcome was ambiguous (prompt dismissed or
        // interrupted by backgrounding) so the next camera start retries.
        // Not on iOS: the mic came with the combined camera request, and a
        // separate audio-only call is the muted-track pattern to avoid.
        if (!micPrimed && !HOLD_MIC_WITH_CAMERA) {
          micPrimed = true
          void primeMicrophonePermission().then((state) => {
            camera.micPermission = state
            if (state === 'unknown') micPrimed = false
            notify()
          })
        }
      } catch (err) {
        const message = permissionMessage(err)
        camera.permission = { status: 'denied', message }
        camera.error = message
        camera.isReady = false
        notify()
      }
    })()

    startInFlight = run
    try {
      await run
    } finally {
      startInFlight = null
    }
  }

  async function flip(): Promise<void> {
    const previousFacing = facingIntent
    const nextFacing: FacingMode = previousFacing === 'environment' ? 'user' : 'environment'
    facingIntent = nextFacing
    camera.error = null
    const epoch = cameraEpoch
    try {
      const rememberedLens = nextFacing === 'environment' ? await resolveRearLens() : undefined
      const next = await openCombinedOrVideoStream(nextFacing, rememberedLens)
      // A stop() while the open was in flight wins (see start()).
      if (cameraEpoch !== epoch) {
        stopStream(next)
        return
      }
      // The rendered facing (which drives the preview's mirror transform)
      // changes only once the new stream is in hand: setting it up front
      // mirrored the still-showing old feed for the whole camera warm-up.
      camera.facing = nextFacing
      replaceStream(next)
      void syncRearLenses(next)
    } catch (err) {
      facingIntent = previousFacing
      camera.facing = previousFacing
      camera.error = permissionMessage(err)
      notify()
    }
  }

  async function switchRearLens(): Promise<void> {
    const lenses = rearLenses
    if (facingIntent !== 'environment' || lenses.length < 2) return
    // No live stream means the camera is stopped or restarting — switching
    // now would open a camera behind that lifecycle's back.
    if (!camera.stream) return
    if (lensSwitchInFlight) return
    lensSwitchInFlight = true
    try {
      const current = camera.stream
      const activeId = current?.getVideoTracks()[0]?.getSettings().deviceId ?? ''
      const foundIndex = lenses.indexOf(activeId)
      // When the open stream and the enumeration disagree (id rotation,
      // fallback opens), advance from the lens the UI shows instead of
      // silently jumping back to the first lens.
      const activeIndex = foundIndex >= 0 ? foundIndex : camera.rearLensIndex
      const nextId = lenses[(activeIndex + 1) % lenses.length]!
      // Android camera HALs are often exclusive across rear lenses: release
      // the current camera before opening the next one.
      stopStream(current)
      camera.stream = null
      camera.isReady = false
      notify()
      // A flip or a full stop (e.g. tab hidden) may land while a lens open
      // is in flight — never adopt a stream into a stopped or flipped camera.
      const epoch = cameraEpoch
      const adopt = (opened: MediaStream): boolean => {
        if (facingIntent !== 'environment' || cameraEpoch !== epoch) {
          stopStream(opened)
          return false
        }
        replaceStream(opened)
        void syncRearLenses(opened)
        return true
      }
      try {
        const next = await openCombinedOrVideoStream('environment', nextId)
        const openedId = next.getVideoTracks()[0]?.getSettings().deviceId ?? ''
        if (!adopt(next)) return
        // Memory must mirror what's actually on screen: the requested lens,
        // or the fallback the browser opened instead (facing-mode fallback on
        // stale ids) — never a stale entry a reload would diverge to.
        const openedIndex = lenses.indexOf(openedId)
        rememberRearLens(
          openedId && openedIndex >= 0 ? { id: openedId, index: openedIndex } : null,
        )
      } catch (err) {
        // Try to restore the lens we just released.
        try {
          const restored = await openCombinedOrVideoStream('environment', activeId || undefined)
          adopt(restored)
        } catch {
          camera.error = permissionMessage(err)
          notify()
        }
      }
    } finally {
      lensSwitchInFlight = false
    }
  }

  function setZoom(value: number): void {
    const track = camera.stream?.getVideoTracks()[0]
    const range = camera.zoom
    if (!track || !range) return
    const clamped = Math.min(range.max, Math.max(range.min, value))
    camera.zoom = { ...range, value: clamped }
    void track
      .applyConstraints({ advanced: [{ zoom: clamped } as MediaTrackConstraintSet] })
      .catch(() => undefined)
    // Constraints apply immediately; the owning component syncs on a trailing
    // timer so drag-to-zoom during a recording doesn't rerender per move.
    if (!zoomNotifyTimer) {
      zoomNotifyTimer = window.setTimeout(() => {
        zoomNotifyTimer = 0
        notify()
      }, 150)
    }
  }

  async function setTorch(on: boolean): Promise<void> {
    const track = camera.stream?.getVideoTracks()[0]
    if (!track) return
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] })
      camera.torchOn = on
    } catch {
      camera.torchOn = false
    }
    notify()
  }

  function releaseMic(): void {
    // iOS: the mic lives and dies with the camera stream (single-call
    // pattern) — stopping it per-take would force the separate audio-only
    // getUserMedia that produces muted tracks on the next take.
    if (HOLD_MIC_WITH_CAMERA) return
    stopAudioTracks(camera.stream)
  }

  async function enableMic(): Promise<void> {
    if (micInFlight) {
      await micInFlight
      if (!camera.stream?.getAudioTracks().some((track) => track.readyState === 'live')) {
        throw new Error('Microphone unavailable')
      }
      return
    }

    /**
     * iOS-only recovery for a preview that opened without audio (mic was
     * denied at start, later granted in settings): reopen camera + mic as
     * one combined request and adopt it. Attaching a separately-acquired
     * audio track here would recreate the muted-track pattern this module
     * exists to avoid.
     */
    const reopenCombinedStream = async (): Promise<void> => {
      const current = camera.stream
      if (!current) throw new Error('Camera not ready')
      const epoch = cameraEpoch
      const deviceId = current.getVideoTracks()[0]?.getSettings().deviceId
      const next = await openCameraStream(facingIntent, { audio: true, deviceId })
      // The camera may have been stopped or swapped while the permission
      // prompt was open — never adopt into that lifecycle's back.
      if (cameraEpoch !== epoch || camera.stream !== current) {
        stopStream(next)
        throw new Error('Camera changed while enabling microphone')
      }
      replaceStream(next)
    }

    const attachToCurrentStream = async (attempt = 0): Promise<void> => {
      const current = camera.stream
      if (!current) {
        throw new Error('Camera not ready')
      }
      if (current.getAudioTracks().some((track) => track.readyState === 'live')) return
      if (HOLD_MIC_WITH_CAMERA) {
        await reopenCombinedStream()
        return
      }

      const audioTrack = await openMicrophoneTrack()
      const latest = camera.stream
      if (!latest) {
        audioTrack.stop()
        throw new Error('Camera not ready')
      }
      if (latest !== current) {
        // Stream swapped (flip/restart) while the permission prompt was open — attach to the new one.
        audioTrack.stop()
        if (attempt >= 2) {
          throw new Error('Camera changed while enabling microphone')
        }
        await attachToCurrentStream(attempt + 1)
        return
      }
      current.addTrack(audioTrack)
    }

    const run = (async () => {
      try {
        await attachToCurrentStream()
        if (!camera.stream?.getAudioTracks().some((track) => track.readyState === 'live')) {
          throw new Error('Microphone unavailable')
        }
        // The user may have fixed a denied permission in site settings.
        camera.micPermission = 'granted'
        notify()
      } catch (err) {
        throw new Error(permissionMessage(err))
      }
    })()

    micInFlight = run
    try {
      await run
    } finally {
      micInFlight = null
    }
  }

  function stop(): void {
    cameraEpoch += 1
    const hadMic = (camera.stream?.getAudioTracks().length ?? 0) > 0
    stopStream(camera.stream)
    camera.stream = null
    camera.isReady = false
    setZoomRange(null)
    camera.torchAvailable = false
    camera.torchOn = false
    if (videoEl) {
      videoEl.srcObject = null
    }
    // The play-and-record session is sticky after capture ends and degrades
    // playback output — restore hi-fi routing (no-op off iOS).
    if (hadMic) releaseRecordAudioSession()
    notify()
  }

  function attachVideo(element: HTMLVideoElement, signal: AbortSignal): void {
    videoEl = element
    signal.addEventListener('abort', () => {
      videoEl = null
      stop()
    })
    if (camera.stream) {
      attachToVideo(camera.stream)
      return
    }
    void start()
  }

  return camera
}

function permissionMessage(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return 'Camera/microphone permission denied. Allow access in site settings, then try again.'
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'No camera was found on this device.'
      case 'NotReadableError':
      case 'TrackStartError':
        return 'Camera or mic is in use by another app. Close it and retry.'
      case 'SecurityError':
        return 'Camera requires a secure context (HTTPS or localhost).'
      default:
        return err.message || 'Could not open the camera.'
    }
  }
  if (err instanceof Error) return err.message
  return 'Could not open the camera.'
}
