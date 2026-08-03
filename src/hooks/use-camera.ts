import { useCallback, useRef, useState, type RefCallback } from 'react'
import {
  canFlipCamera,
  isIosBrowser,
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
} from '../lib/media'

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

export interface UseCameraResult {
  videoRef: RefCallback<HTMLVideoElement>
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
  /** Cycle to the next rear lens (no-op while facing the user). */
  switchRearLens: () => Promise<void>
  start: () => Promise<void>
  flip: () => Promise<void>
  stop: () => void
  setZoom: (value: number) => void
  setTorch: (on: boolean) => Promise<void>
  enableMic: () => Promise<void>
  releaseMic: () => void
  /** Latest live stream from the ref (safer than React state after awaits). */
  getStream: () => MediaStream | null
  /** The live preview element — for zero-cost frame capture at take end. */
  getVideoElement: () => HTMLVideoElement | null
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

/**
 * Camera lifecycle is event/ref-driven (no useEffect):
 * - Video ref callback attaches/detaches the stream and starts capture when mounted.
 * - Preview is video-only so Android OS voice-to-text can keep the mic;
 *   enableMic/releaseMic attach a mic track only while recording.
 * - Except iOS: mic comes with the camera in one combined call and stays for
 *   the preview's lifetime (see HOLD_MIC_WITH_CAMERA).
 */
export function useCamera(): UseCameraResult {
  const streamRef = useRef<MediaStream | null>(null)
  const videoElRef = useRef<HTMLVideoElement | null>(null)
  const facingRef = useRef<FacingMode>('environment')
  const startInFlightRef = useRef<Promise<void> | null>(null)
  const micInFlightRef = useRef<Promise<void> | null>(null)

  const [stream, setStream] = useState<MediaStream | null>(null)
  const [facing, setFacing] = useState<FacingMode>('environment')
  const [permission, setPermission] = useState<CameraPermissionState>({ status: 'unknown' })
  const [canFlip, setCanFlip] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isReady, setIsReady] = useState(false)
  const [zoom, setZoomState] = useState<CameraZoomRange | null>(null)
  const [torchAvailable, setTorchAvailable] = useState(false)
  const [torchOn, setTorchOn] = useState(false)
  const [micPermission, setMicPermission] = useState<'granted' | 'denied' | 'unknown'>('unknown')
  const micPrimedRef = useRef(false)
  const [rearLensCount, setRearLensCount] = useState(0)
  const [rearLensIndex, setRearLensIndex] = useState(0)
  const rearLensesRef = useRef<string[]>([])
  const rearLensIndexRef = useRef(0)
  const lensSwitchInFlightRef = useRef(false)
  /** Bumped by stop(): async opens started before a stop must not adopt. */
  const cameraEpochRef = useRef(0)

  const zoomRangeRef = useRef<CameraZoomRange | null>(null)
  const zoomSyncTimerRef = useRef(0)

  const applyZoomState = useCallback((next: CameraZoomRange | null) => {
    window.clearTimeout(zoomSyncTimerRef.current)
    zoomSyncTimerRef.current = 0
    zoomRangeRef.current = next
    setZoomState(next)
  }, [])

  const attachToVideo = useCallback((next: MediaStream) => {
    const video = videoElRef.current
    if (!video) return
    video.srcObject = next
    void video.play().catch(() => undefined)
  }, [])

  const readTrackCapabilities = useCallback(
    (next: MediaStream) => {
      const track = next.getVideoTracks()[0]
      if (!track || typeof track.getCapabilities !== 'function') {
        applyZoomState(null)
        setTorchAvailable(false)
        setTorchOn(false)
        return
      }
      try {
        const caps = track.getCapabilities() as ExtendedCapabilities
        if (caps.zoom && typeof caps.zoom.min === 'number' && typeof caps.zoom.max === 'number') {
          const settings = track.getSettings() as ExtendedSettings
          applyZoomState({
            min: caps.zoom.min,
            max: caps.zoom.max,
            step: caps.zoom.step && caps.zoom.step > 0 ? caps.zoom.step : 0.1,
            value: typeof settings.zoom === 'number' ? settings.zoom : caps.zoom.min,
          })
        } else {
          applyZoomState(null)
        }
        setTorchAvailable(caps.torch === true)
        setTorchOn(false)
      } catch {
        applyZoomState(null)
        setTorchAvailable(false)
        setTorchOn(false)
      }
    },
    [applyZoomState],
  )

  const replaceStream = useCallback(
    (next: MediaStream) => {
      stopStream(streamRef.current)
      streamRef.current = next
      setStream(next)
      attachToVideo(next)
      readTrackCapabilities(next)
      // iOS: every (re)open is a combined request, so the adopted stream's
      // audio presence is the freshest mic-permission signal — including
      // after flips and lens switches. A missing track is NOT proof of a
      // denial though (the combined open also falls back on transient
      // failures) — only the Permissions API may claim "blocked".
      if (HOLD_MIC_WITH_CAMERA) {
        if (next.getAudioTracks().length > 0) setMicPermission('granted')
        else void queryMicrophonePermission().then(setMicPermission)
      }
      setIsReady(true)
    },
    [attachToVideo, readTrackCapabilities],
  )

  /** Discover rear lenses and locate the active one (post-permission only).
   * Not on iOS: the OS handles lens switching through the virtual composite
   * camera's zoom range, and offering six raw devices (physical lenses plus
   * composites) as a cycling chip is confusing noise there. */
  const syncRearLenses = useCallback(async (active: MediaStream) => {
    if (facingRef.current !== 'environment' || isIosBrowser()) {
      rearLensesRef.current = []
      setRearLensCount(0)
      setRearLensIndex(0)
      return
    }
    const lenses = await listRearCameras()
    // A flip/stop/switch may have replaced the stream while enumerating —
    // stale results must not clobber the newer call's state.
    if (streamRef.current !== active || facingRef.current !== 'environment') return
    rearLensesRef.current = lenses
    setRearLensCount(lenses.length)
    const activeId = active.getVideoTracks()[0]?.getSettings().deviceId ?? ''
    const index = lenses.indexOf(activeId)
    rearLensIndexRef.current = index >= 0 ? index : 0
    setRearLensIndex(index >= 0 ? index : 0)
  }, [])

  const start = useCallback(async () => {
    if (startInFlightRef.current) {
      await startInFlightRef.current
      return
    }

    const run = (async () => {
      setError(null)
      const perm = await queryCameraPermission()
      setPermission(perm)
      if (perm.status === 'unsupported') {
        setError(perm.message ?? 'Camera unsupported')
        return
      }

      try {
        const rememberedLens =
          facingRef.current === 'environment' ? await resolveRearLens() : undefined
        let next = await openCombinedOrVideoStream(facingRef.current, rememberedLens)
        setPermission({ status: 'granted' })
        // iOS first run: device labels are empty before the permission grant,
        // so the preferred multi-lens camera can't be resolved until now.
        // Re-resolve and reopen once so 0.5× works from the very first
        // session, not just after a restart.
        if (isIosBrowser() && !rememberedLens && facingRef.current === 'environment') {
          const preferred = await preferredIosRearCameraId()
          const activeId = next.getVideoTracks()[0]?.getSettings().deviceId
          if (preferred && preferred !== activeId) {
            const epoch = cameraEpochRef.current
            // iOS camera access is exclusive — release before reopening.
            stopStream(next)
            const reopened = await openCombinedOrVideoStream(facingRef.current, preferred)
            if (cameraEpochRef.current !== epoch) {
              stopStream(reopened)
              return
            }
            next = reopened
          }
        }
        replaceStream(next)
        setCanFlip(await canFlipCamera())
        void syncRearLenses(next)
        // Mic permission priming (see primeMicrophonePermission): asking
        // mid-hold is silently denied by some browsers (Brave/Android never
        // shows the prompt). Prompt now, at a normal moment. The claim is
        // released when the outcome was ambiguous (prompt dismissed or
        // interrupted by backgrounding) so the next camera start retries.
        // Not on iOS: the mic came with the combined camera request, and a
        // separate audio-only call is the muted-track pattern to avoid.
        if (!micPrimedRef.current && !HOLD_MIC_WITH_CAMERA) {
          micPrimedRef.current = true
          void primeMicrophonePermission().then((state) => {
            setMicPermission(state)
            if (state === 'unknown') micPrimedRef.current = false
          })
        }
      } catch (err) {
        const message = permissionMessage(err)
        setPermission({ status: 'denied', message })
        setError(message)
        setIsReady(false)
      }
    })()

    startInFlightRef.current = run
    try {
      await run
    } finally {
      startInFlightRef.current = null
    }
  }, [replaceStream])

  const flip = useCallback(async () => {
    const previousFacing = facingRef.current
    const nextFacing: FacingMode = previousFacing === 'environment' ? 'user' : 'environment'
    facingRef.current = nextFacing
    setError(null)
    try {
      const rememberedLens =
        nextFacing === 'environment' ? await resolveRearLens() : undefined
      const next = await openCombinedOrVideoStream(nextFacing, rememberedLens)
      // The facing STATE (which drives the preview's mirror transform)
      // changes only once the new stream is in hand: setting it up front
      // mirrored the still-showing old feed for the whole camera warm-up.
      // Both updates land in one React commit, so mirror and feed swap
      // together.
      setFacing(nextFacing)
      replaceStream(next)
      void syncRearLenses(next)
    } catch (err) {
      facingRef.current = previousFacing
      setFacing(previousFacing)
      setError(permissionMessage(err))
    }
  }, [replaceStream, syncRearLenses])

  const switchRearLens = useCallback(async () => {
    const lenses = rearLensesRef.current
    if (facingRef.current !== 'environment' || lenses.length < 2) return
    // No live stream means the camera is stopped or restarting — switching
    // now would open a camera behind that lifecycle's back.
    if (!streamRef.current) return
    if (lensSwitchInFlightRef.current) return
    lensSwitchInFlightRef.current = true
    try {
      const current = streamRef.current
      const activeId = current?.getVideoTracks()[0]?.getSettings().deviceId ?? ''
      const foundIndex = lenses.indexOf(activeId)
      // When the open stream and the enumeration disagree (id rotation,
      // fallback opens), advance from the lens the UI shows instead of
      // silently jumping back to the first lens.
      const activeIndex = foundIndex >= 0 ? foundIndex : rearLensIndexRef.current
      const nextId = lenses[(activeIndex + 1) % lenses.length]!
      // Android camera HALs are often exclusive across rear lenses: release
      // the current camera before opening the next one.
      stopStream(current)
      streamRef.current = null
      setStream(null)
      setIsReady(false)
      // A flip or a full stop (e.g. tab hidden) may land while a lens open
      // is in flight — never adopt a stream into a stopped or flipped camera.
      const epoch = cameraEpochRef.current
      const adopt = (opened: MediaStream): boolean => {
        if (facingRef.current !== 'environment' || cameraEpochRef.current !== epoch) {
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
          setError(permissionMessage(err))
        }
      }
    } finally {
      lensSwitchInFlightRef.current = false
    }
  }, [replaceStream, syncRearLenses])

  const setZoom = useCallback((value: number) => {
    const track = streamRef.current?.getVideoTracks()[0]
    const range = zoomRangeRef.current
    if (!track || !range) return
    const clamped = Math.min(range.max, Math.max(range.min, value))
    zoomRangeRef.current = { ...range, value: clamped }
    void track
      .applyConstraints({ advanced: [{ zoom: clamped } as MediaTrackConstraintSet] })
      .catch(() => undefined)
    // Constraints apply immediately; React state syncs on a trailing timer so
    // drag-to-zoom during a recording doesn't re-render the page per move.
    if (!zoomSyncTimerRef.current) {
      zoomSyncTimerRef.current = window.setTimeout(() => {
        zoomSyncTimerRef.current = 0
        if (zoomRangeRef.current) setZoomState(zoomRangeRef.current)
      }, 150)
    }
  }, [])

  const setTorch = useCallback(async (on: boolean) => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] })
      setTorchOn(on)
    } catch {
      setTorchOn(false)
    }
  }, [])

  const releaseMic = useCallback(() => {
    // iOS: the mic lives and dies with the camera stream (single-call
    // pattern) — stopping it per-take would force the separate audio-only
    // getUserMedia that produces muted tracks on the next take.
    if (HOLD_MIC_WITH_CAMERA) return
    stopAudioTracks(streamRef.current)
  }, [])

  const enableMic = useCallback(async () => {
    if (micInFlightRef.current) {
      await micInFlightRef.current
      if (!streamRef.current?.getAudioTracks().some((track) => track.readyState === 'live')) {
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
      const current = streamRef.current
      if (!current) throw new Error('Camera not ready')
      const epoch = cameraEpochRef.current
      const deviceId = current.getVideoTracks()[0]?.getSettings().deviceId
      const next = await openCameraStream(facingRef.current, { audio: true, deviceId })
      // The camera may have been stopped or swapped while the permission
      // prompt was open — never adopt into that lifecycle's back.
      if (cameraEpochRef.current !== epoch || streamRef.current !== current) {
        stopStream(next)
        throw new Error('Camera changed while enabling microphone')
      }
      replaceStream(next)
    }

    const attachToCurrentStream = async (attempt = 0): Promise<void> => {
      const current = streamRef.current
      if (!current) {
        throw new Error('Camera not ready')
      }
      if (current.getAudioTracks().some((track) => track.readyState === 'live')) return
      if (HOLD_MIC_WITH_CAMERA) {
        await reopenCombinedStream()
        return
      }

      const audioTrack = await openMicrophoneTrack()
      const latest = streamRef.current
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
        if (!streamRef.current?.getAudioTracks().some((track) => track.readyState === 'live')) {
          throw new Error('Microphone unavailable')
        }
        // The user may have fixed a denied permission in site settings.
        setMicPermission('granted')
      } catch (err) {
        throw new Error(permissionMessage(err))
      }
    })()

    micInFlightRef.current = run
    try {
      await run
    } finally {
      micInFlightRef.current = null
    }
  }, [replaceStream])

  const stop = useCallback(() => {
    cameraEpochRef.current += 1
    stopStream(streamRef.current)
    streamRef.current = null
    setStream(null)
    setIsReady(false)
    applyZoomState(null)
    setTorchAvailable(false)
    setTorchOn(false)
    if (videoElRef.current) {
      videoElRef.current.srcObject = null
    }
  }, [applyZoomState])

  const videoRef = useCallback<RefCallback<HTMLVideoElement>>(
    (element) => {
      videoElRef.current = element
      if (!element) {
        stop()
        return
      }
      if (streamRef.current) {
        attachToVideo(streamRef.current)
        return
      }
      void start()
    },
    [attachToVideo, start, stop],
  )

  const getStream = useCallback(() => streamRef.current, [])
  const getVideoElement = useCallback(() => videoElRef.current, [])

  return {
    videoRef,
    stream,
    facing,
    permission,
    canFlip,
    error,
    isReady,
    zoom,
    torchAvailable,
    torchOn,
    micPermission,
    rearLensCount,
    rearLensIndex,
    switchRearLens,
    start,
    flip,
    stop,
    setZoom,
    setTorch,
    enableMic,
    releaseMic,
    getStream,
    getVideoElement,
  }
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
