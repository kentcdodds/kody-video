import { useCallback, useRef, useState, type RefCallback } from 'react'
import {
  canFlipCamera,
  listRearCameras,
  openCameraStream,
  openMicrophoneTrack,
  queryCameraPermission,
  stopAudioTracks,
  stopStream,
  type CameraPermissionState,
  type FacingMode,
} from '../lib/media'

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
 * still valid, otherwise the same position, otherwise nothing. */
async function resolveRememberedLens(): Promise<string | undefined> {
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
 * - Preview is video-only so Android OS voice-to-text can keep the mic.
 * - enableMic/releaseMic attach a mic track only while recording.
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
  const [rearLensCount, setRearLensCount] = useState(0)
  const [rearLensIndex, setRearLensIndex] = useState(0)
  const rearLensesRef = useRef<string[]>([])
  const lensSwitchInFlightRef = useRef(false)

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
      setIsReady(true)
    },
    [attachToVideo, readTrackCapabilities],
  )

  /** Discover rear lenses and locate the active one (post-permission only). */
  const syncRearLenses = useCallback(async (active: MediaStream) => {
    if (facingRef.current !== 'environment') {
      rearLensesRef.current = []
      setRearLensCount(0)
      setRearLensIndex(0)
      return
    }
    const lenses = await listRearCameras()
    rearLensesRef.current = lenses
    setRearLensCount(lenses.length)
    const activeId = active.getVideoTracks()[0]?.getSettings().deviceId ?? ''
    const index = lenses.indexOf(activeId)
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
          facingRef.current === 'environment' ? await resolveRememberedLens() : undefined
        const next = await openCameraStream(facingRef.current, {
          audio: false,
          deviceId: rememberedLens,
        })
        setPermission({ status: 'granted' })
        replaceStream(next)
        setCanFlip(await canFlipCamera())
        void syncRearLenses(next)
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
    setFacing(nextFacing)
    setError(null)
    try {
      const rememberedLens =
        nextFacing === 'environment' ? await resolveRememberedLens() : undefined
      const next = await openCameraStream(nextFacing, { audio: false, deviceId: rememberedLens })
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
    if (lensSwitchInFlightRef.current) return
    lensSwitchInFlightRef.current = true
    try {
      const current = streamRef.current
      const activeId = current?.getVideoTracks()[0]?.getSettings().deviceId ?? ''
      const activeIndex = lenses.indexOf(activeId)
      const nextId = lenses[(activeIndex + 1) % lenses.length]!
      // Android camera HALs are often exclusive across rear lenses: release
      // the current camera before opening the next one.
      stopStream(current)
      streamRef.current = null
      setIsReady(false)
      // A flip may land while a lens open is in flight; its stream must win.
      const adopt = (opened: MediaStream): boolean => {
        if (facingRef.current !== 'environment') {
          stopStream(opened)
          return false
        }
        replaceStream(opened)
        void syncRearLenses(opened)
        return true
      }
      try {
        const next = await openCameraStream('environment', { audio: false, deviceId: nextId })
        const openedId = next.getVideoTracks()[0]?.getSettings().deviceId ?? ''
        if (!adopt(next)) return
        // openCameraStream falls back to facing mode when the exact device
        // can't be opened — only persist a lens the user actually reached,
        // never an unintended fallback.
        if (openedId === nextId) {
          rememberRearLens({ id: openedId, index: lenses.indexOf(openedId) })
        }
      } catch (err) {
        // Try to restore the lens we just released.
        try {
          const restored = await openCameraStream('environment', {
            audio: false,
            deviceId: activeId || undefined,
          })
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

    const attachToCurrentStream = async (attempt = 0): Promise<void> => {
      const current = streamRef.current
      if (!current) {
        throw new Error('Camera not ready')
      }
      if (current.getAudioTracks().some((track) => track.readyState === 'live')) return

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
  }, [])

  const stop = useCallback(() => {
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
