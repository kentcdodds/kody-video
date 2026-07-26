import { useCallback, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { UseCameraResult } from '../hooks/use-camera'
import { appendRecording, removeClip, undoLastDelete } from '../lib/project-actions'
import { HoldRecorder } from '../lib/recorder'
import { effectiveDurationMs, formatDuration, type ClipRecord, type Project } from '../lib/types'
import { RecordTimer } from './record-timer'

type RecordingMode = 'hold' | 'hands-free'

export interface ToastAction {
  actionLabel: string
  onAction: () => void
}

interface RecordScreenProps {
  project: Project
  clips: ClipRecord[]
  camera: UseCameraResult
  /** True while an overlay (export, preview, onboarding) should block capture. */
  interactionLocked: boolean
  onOpenEditor: () => void
  onOpenExport: () => void
  onPlay: () => void
  showToast: (message: string, action?: ToastAction) => void
  refresh: () => void
}

export function RecordScreen({
  project,
  clips,
  camera,
  interactionLocked,
  onOpenEditor,
  onOpenExport,
  onPlay,
  showToast,
  refresh,
}: RecordScreenProps) {
  const recorderRef = useRef(new HoldRecorder())
  const pointerIdRef = useRef<number | null>(null)
  const beginInFlightRef = useRef(false)
  const countdownTimerRef = useRef(0)
  const wakeLockRef = useRef<WakeLockSentinel | null>(null)
  const lockedRef = useRef(interactionLocked)
  lockedRef.current = interactionLocked

  const [recording, setRecording] = useState(false)
  const [recordingMode, setRecordingMode] = useState<RecordingMode | null>(null)
  const [recordStartedAt, setRecordStartedAt] = useState(0)
  const [countdown, setCountdown] = useState<number | null>(null)

  const totalDurationMs = clips.reduce((sum, clip) => sum + effectiveDurationMs(clip), 0)

  const clearCountdown = useCallback(() => {
    window.clearTimeout(countdownTimerRef.current)
    countdownTimerRef.current = 0
    setCountdown(null)
  }, [])

  const acquireWakeLock = useCallback(() => {
    void navigator.wakeLock
      ?.request('screen')
      .then((sentinel) => {
        wakeLockRef.current = sentinel
      })
      .catch(() => undefined)
  }, [])

  const releaseWakeLock = useCallback(() => {
    void wakeLockRef.current?.release().catch(() => undefined)
    wakeLockRef.current = null
  }, [])

  const beginRecord = useCallback(
    async (pointerId: number | null, nextRecordingMode: RecordingMode): Promise<boolean> => {
      if (
        beginInFlightRef.current ||
        recording ||
        recorderRef.current.isRecording ||
        lockedRef.current ||
        countdown !== null
      ) {
        return false
      }
      if (!camera.getStream() || !camera.isReady) {
        showToast('Camera not ready')
        return false
      }

      beginInFlightRef.current = true
      pointerIdRef.current = pointerId
      try {
        // Grab the mic only for this take so Brave/Android voice-to-text stays free while idle.
        await camera.enableMic()
        if (pointerId !== null && pointerIdRef.current !== pointerId) {
          camera.releaseMic()
          return false
        }
        if (nextRecordingMode === 'hold' && pointerId !== null && pointerIdRef.current === null) {
          camera.releaseMic()
          return false
        }
        // Re-check after the mic await — an overlay may have opened meanwhile.
        if (lockedRef.current) {
          camera.releaseMic()
          return false
        }

        const stream = camera.getStream()
        if (!stream?.getAudioTracks().some((track) => track.readyState === 'live')) {
          throw new Error('Microphone unavailable')
        }

        const startedOk = recorderRef.current.start(stream)
        if (!startedOk) {
          pointerIdRef.current = null
          // Never strip mic from an already-active recording owned by another start.
          if (!recorderRef.current.isRecording) camera.releaseMic()
          showToast('Still finishing the last clip')
          return false
        }
        acquireWakeLock()
        setRecording(true)
        setRecordingMode(nextRecordingMode)
        setRecordStartedAt(performance.now())
        return true
      } catch (err) {
        if (!recorderRef.current.isRecording) camera.releaseMic()
        showToast(err instanceof Error ? err.message : 'Could not start recording')
        pointerIdRef.current = null
        setRecordingMode(null)
        return false
      } finally {
        beginInFlightRef.current = false
      }
    },
    [acquireWakeLock, camera, countdown, recording, showToast],
  )

  const endRecord = useCallback(
    async (pointerId?: number) => {
      if (
        pointerId !== undefined &&
        pointerIdRef.current !== null &&
        pointerIdRef.current !== pointerId
      ) {
        return
      }
      if (!recorderRef.current.isRecording && !recording) {
        // Pointer released while mic grant was still in flight.
        pointerIdRef.current = null
        camera.releaseMic()
        return
      }
      pointerIdRef.current = null
      setRecording(false)
      setRecordingMode(null)
      try {
        const result = await recorderRef.current.stop()
        if (!result) {
          showToast('Hold a bit longer')
          return
        }
        await appendRecording(project.id, result)
        refresh()
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Save failed')
      } finally {
        camera.releaseMic()
        releaseWakeLock()
      }
    },
    [camera, project.id, recording, refresh, releaseWakeLock, showToast],
  )

  const startSelfTimer = useCallback(() => {
    if (recording || lockedRef.current || countdown !== null) return
    if (!camera.getStream() || !camera.isReady) {
      showToast('Camera not ready')
      return
    }

    let next = 3
    setCountdown(next)
    const tick = () => {
      next -= 1
      if (next <= 0) {
        countdownTimerRef.current = 0
        setCountdown(null)
        void (async () => {
          const started = await beginRecord(null, 'hands-free')
          if (started) {
            showToast('Recording hands-free — tap the preview to stop')
          }
        })()
        return
      }
      setCountdown(next)
      countdownTimerRef.current = window.setTimeout(tick, 1000)
    }
    countdownTimerRef.current = window.setTimeout(tick, 1000)
  }, [beginRecord, camera, countdown, recording, showToast])

  const deleteLastClip = useCallback(() => {
    const lastClip = clips.at(-1)
    if (!lastClip) {
      showToast('No clips yet')
      return
    }
    void (async () => {
      await removeClip(lastClip.id)
      refresh()
      showToast('Last clip deleted', {
        actionLabel: 'Undo',
        onAction: () => {
          void (async () => {
            await undoLastDelete(project.id)
            refresh()
            showToast('Clip restored')
          })()
        },
      })
    })()
  }, [clips, project.id, refresh, showToast])

  const cleanupOnUnmount = useCallback(() => {
    clearCountdown()
    recorderRef.current.cancel()
    releaseWakeLock()
  }, [clearCountdown, releaseWakeLock])

  const attachCameraVideo = camera.videoRef
  const bindCameraVideo = useCallback(
    (element: HTMLVideoElement | null) => {
      if (!element) {
        cleanupOnUnmount()
      }
      attachCameraVideo(element)
    },
    [attachCameraVideo, cleanupOnUnmount],
  )

  const needsPermission =
    camera.permission.status === 'denied' ||
    camera.permission.status === 'unsupported' ||
    (!!camera.error && !camera.isReady)

  return (
    <div className={`record-screen${recording ? ' is-recording' : ''}`}>
      <div
        className="record-stage"
        onPointerDown={(event) => {
          if (event.button !== 0) return
          if (countdown !== null) {
            clearCountdown()
            showToast('Timer canceled')
            return
          }
          if (recording && recordingMode === 'hands-free') {
            void endRecord()
            return
          }
          event.currentTarget.setPointerCapture(event.pointerId)
          void beginRecord(event.pointerId, 'hold')
        }}
        onPointerUp={(event) => {
          if (recordingMode !== 'hands-free') {
            void endRecord(event.pointerId)
          }
        }}
        onPointerCancel={(event) => {
          if (recordingMode !== 'hands-free') {
            void endRecord(event.pointerId)
          }
        }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <video
          ref={bindCameraVideo}
          className={`camera-video${camera.facing === 'user' ? ' mirror' : ''}`}
          muted
          playsInline
          autoPlay
        />

        {recording ? (
          <div className="record-overlay">
            <div className="record-pill" aria-live="polite">
              <span className="record-dot" />
              {recordingMode === 'hands-free' ? 'TAP TO STOP' : 'REC'}{' '}
              <RecordTimer startedAt={recordStartedAt} className="record-elapsed" />
            </div>
          </div>
        ) : null}

        {countdown !== null ? (
          <div className="countdown-overlay" aria-live="assertive">
            {countdown}
          </div>
        ) : null}

        {!recording && countdown === null && camera.isReady ? (
          <div className="hold-hint">
            <strong>Hold anywhere</strong>
            <span>release to stop</span>
          </div>
        ) : null}

        {needsPermission ? (
          <div className="permission-panel">
            <div>
              <h2>Camera access</h2>
              <p>
                {camera.error ??
                  camera.permission.message ??
                  'Allow camera to preview. Microphone is requested only while you record.'}
              </p>
              <button type="button" className="btn btn-primary" onClick={() => void camera.start()}>
                Try again
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="record-top">
        <Link to="/" className="btn-icon" aria-label="Back to projects" onClick={cleanupOnUnmount}>
          ←
        </Link>
        <div className="record-meta">
          <strong>{project.name}</strong>
          <small>{formatDuration(totalDurationMs)}</small>
        </div>
        <button
          type="button"
          className="btn-icon"
          aria-label="Flip camera"
          disabled={!camera.canFlip || recording || countdown !== null}
          onClick={() => void camera.flip()}
        >
          ↻
        </button>
      </div>

      <div className="record-dock">
        <div className="record-tools">
          <button
            type="button"
            className="btn-icon"
            aria-label="Open editor"
            disabled={recording}
            onClick={() => {
              camera.releaseMic()
              onOpenEditor()
            }}
          >
            ✂
          </button>
          <button
            type="button"
            className="btn-icon"
            aria-label="Self-timer"
            disabled={recording || countdown !== null}
            onClick={startSelfTimer}
          >
            ⏱
          </button>
          <button
            type="button"
            className="btn-icon"
            aria-label="Play project preview"
            disabled={recording || clips.length === 0}
            onClick={onPlay}
          >
            ▶
          </button>
          <button
            type="button"
            className="btn-icon"
            aria-label="Delete last clip"
            disabled={recording || clips.length === 0}
            onClick={deleteLastClip}
          >
            ⌫
          </button>
        </div>
        <button
          type="button"
          className="ok-button"
          disabled={clips.length === 0 || recording}
          onClick={onOpenExport}
        >
          OK
        </button>
      </div>
    </div>
  )
}
