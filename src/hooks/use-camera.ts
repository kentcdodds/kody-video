import { useCallback, useRef, useState, type RefCallback } from 'react'
import {
  canFlipCamera,
  openCameraStream,
  queryCameraPermission,
  stopStream,
  type CameraPermissionState,
  type FacingMode,
} from '../lib/media'

export interface UseCameraResult {
  videoRef: RefCallback<HTMLVideoElement>
  stream: MediaStream | null
  facing: FacingMode
  permission: CameraPermissionState
  canFlip: boolean
  error: string | null
  isReady: boolean
  start: () => Promise<void>
  flip: () => Promise<void>
  stop: () => void
}

/**
 * Camera lifecycle is event/ref-driven (no useEffect):
 * - Video ref callback attaches/detaches the stream and starts capture when mounted.
 * - Flip/retry run from user events.
 * - Unmounting the video element stops tracks.
 */
export function useCamera(): UseCameraResult {
  const streamRef = useRef<MediaStream | null>(null)
  const videoElRef = useRef<HTMLVideoElement | null>(null)
  const facingRef = useRef<FacingMode>('environment')
  const startInFlightRef = useRef<Promise<void> | null>(null)

  const [stream, setStream] = useState<MediaStream | null>(null)
  const [facing, setFacing] = useState<FacingMode>('environment')
  const [permission, setPermission] = useState<CameraPermissionState>({ status: 'unknown' })
  const [canFlip, setCanFlip] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isReady, setIsReady] = useState(false)

  const attachToVideo = useCallback((next: MediaStream) => {
    const video = videoElRef.current
    if (!video) return
    video.srcObject = next
    void video.play().catch(() => undefined)
  }, [])

  const replaceStream = useCallback(
    (next: MediaStream) => {
      stopStream(streamRef.current)
      streamRef.current = next
      setStream(next)
      attachToVideo(next)
      setIsReady(true)
    },
    [attachToVideo],
  )

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
        const next = await openCameraStream(facingRef.current)
        setPermission({ status: 'granted' })
        replaceStream(next)
        setCanFlip(await canFlipCamera())
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
    const nextFacing: FacingMode = facingRef.current === 'environment' ? 'user' : 'environment'
    facingRef.current = nextFacing
    setFacing(nextFacing)
    setError(null)
    try {
      const next = await openCameraStream(nextFacing)
      replaceStream(next)
    } catch (err) {
      setError(permissionMessage(err))
    }
  }, [replaceStream])

  const stop = useCallback(() => {
    stopStream(streamRef.current)
    streamRef.current = null
    setStream(null)
    setIsReady(false)
    if (videoElRef.current) {
      videoElRef.current.srcObject = null
    }
  }, [])

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

  return {
    videoRef,
    stream,
    facing,
    permission,
    canFlip,
    error,
    isReady,
    start,
    flip,
    stop,
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
        return 'Camera is in use by another app. Close it and retry.'
      case 'SecurityError':
        return 'Camera requires a secure context (HTTPS or localhost).'
      default:
        return err.message || 'Could not open the camera.'
    }
  }
  if (err instanceof Error) return err.message
  return 'Could not open the camera.'
}
