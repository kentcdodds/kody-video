import { useCallback, useRef, useState, type RefCallback } from 'react'
import {
  canFlipCamera,
  openCameraStream,
  openMicrophoneTrack,
  queryCameraPermission,
  stopAudioTracks,
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
  enableMic: () => Promise<void>
  releaseMic: () => void
  /** Latest live stream from the ref (safer than React state after awaits). */
  getStream: () => MediaStream | null
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
        const next = await openCameraStream(facingRef.current, { audio: false })
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
      const next = await openCameraStream(nextFacing, { audio: false })
      replaceStream(next)
    } catch (err) {
      setError(permissionMessage(err))
    }
  }, [replaceStream])

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

  const getStream = useCallback(() => streamRef.current, [])

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
