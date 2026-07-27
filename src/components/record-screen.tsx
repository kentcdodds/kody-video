import { useCallback, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { CameraZoomRange, UseCameraResult } from '../hooks/use-camera'
import { getLocationFix, type LocationFix } from '../lib/location'
import { appendRecording, removeClip, undoLastDelete } from '../lib/project-actions'
import { HoldRecorder } from '../lib/recorder'
import { setLocationTaggingEnabled } from '../lib/storage'
import {
  formatStoragePercent,
  storageSeverity,
  type StorageSpace,
} from '../lib/storage-space'
import { effectiveDurationMs, formatDuration, type ClipRecord, type Project } from '../lib/types'
import {
  IconBack,
  IconDeleteLast,
  IconEditor,
  IconFlip,
  IconLocation,
  IconPlay,
  IconTimer,
  IconTorch,
} from './icons'
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
  /** Device storage estimate for the almost-full warning. */
  storage: StorageSpace | null
  /** True while an overlay (export, preview, onboarding) should block capture. */
  interactionLocked: boolean
  /** Opt-in: tag new clips with device location (shell may pass persisted setting). */
  locationTaggingEnabled?: boolean
  onOpenEditor: () => void
  onOpenExport: () => void
  onPlay: () => void
  showToast: (message: string, action?: ToastAction) => void
  refresh: () => void
}

/** Build a small set of zoom chip levels clamped to device min/max (e.g. 1×, 2×, 5×). */
function zoomChipLevels(zoom: CameraZoomRange): number[] {
  const { min, max } = zoom
  const candidates = [1, 2]
  if (max > 2.05) {
    const rounded = Math.round(max)
    // Prefer a clean integer near max (4×/5×); otherwise use the true max.
    candidates.push(Math.abs(rounded - max) <= 0.35 ? rounded : Number(max.toFixed(1)))
  }
  const levels = candidates
    .map((level) => Math.min(max, Math.max(min, level)))
    .filter((level, index, arr) => arr.findIndex((other) => Math.abs(other - level) < 0.05) === index)
    .sort((a, b) => a - b)
  // Always include device min when it isn't already represented (ultra-wide lenses).
  if (levels.every((level) => Math.abs(level - min) > 0.05)) {
    levels.unshift(min)
  }
  return levels
}

function formatZoomLabel(level: number): string {
  const rounded = Math.round(level * 10) / 10
  if (Number.isInteger(rounded)) return `${rounded}×`
  return `${rounded.toFixed(1)}×`
}

function nearestZoomLevel(levels: number[], value: number): number {
  let best = levels[0]!
  let bestDist = Math.abs(value - best)
  for (const level of levels) {
    const dist = Math.abs(value - level)
    if (dist < bestDist) {
      best = level
      bestDist = dist
    }
  }
  return best
}

export function RecordScreen({
  project,
  clips,
  camera,
  storage,
  interactionLocked,
  locationTaggingEnabled = false,
  onOpenEditor,
  onOpenExport,
  onPlay,
  showToast,
  refresh,
}: RecordScreenProps) {
  const storageState = storage ? storageSeverity(storage.ratio) : 'ok'
  const recorderRef = useRef(new HoldRecorder())
  const pointerIdRef = useRef<number | null>(null)
  const beginInFlightRef = useRef(false)
  const endInFlightRef = useRef(false)
  const countdownTimerRef = useRef(0)
  const wakeLockRef = useRef<WakeLockSentinel | null>(null)
  const wakeLockGenRef = useRef(0)
  const lockedRef = useRef(interactionLocked)
  lockedRef.current = interactionLocked
  /** In-flight GPS fix for the current take; never shared across takes. */
  const pendingFixRef = useRef<Promise<LocationFix | null> | null>(null)
  const locationTaggingRef = useRef(locationTaggingEnabled)

  const dragZoomPressYRef = useRef(0)
  const dragZoomStartValueRef = useRef(0)
  const dragZoomStageHeightRef = useRef(0)
  /** Whether the current hold actually changed zoom (gates the snap-back). */
  const dragZoomMovedRef = useRef(false)
  /** Last zoom value applied during the drag (ramp start for the snap-back). */
  const dragZoomLastValueRef = useRef(0)
  /** Zoom the user chose deliberately (chips) — what a take restores to. */
  const zoomBaselineRef = useRef<number | null>(null)
  const zoomRestoreRafRef = useRef(0)
  /** True while the snap-back ramp is still easing toward the baseline. */
  const zoomRestoreActiveRef = useRef(false)
  const stageRef = useRef<HTMLDivElement | null>(null)

  const [recording, setRecording] = useState(false)
  const [recordingMode, setRecordingMode] = useState<RecordingMode | null>(null)
  const [recordStartedAt, setRecordStartedAt] = useState(0)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [locationTagging, setLocationTagging] = useState(locationTaggingEnabled)
  locationTaggingRef.current = locationTagging

  const totalDurationMs = clips.reduce((sum, clip) => sum + effectiveDurationMs(clip), 0)
  const zoomLevels = camera.zoom ? zoomChipLevels(camera.zoom) : []
  const activeZoomLevel =
    camera.zoom && zoomLevels.length > 0 ? nearestZoomLevel(zoomLevels, camera.zoom.value) : null

  const clearCountdown = useCallback(() => {
    window.clearTimeout(countdownTimerRef.current)
    countdownTimerRef.current = 0
    setCountdown(null)
  }, [])

  /**
   * OK Video behavior: drag-to-zoom only lasts for the take. When the finger
   * lifts, ease the lens back to the zoom the user had before recording.
   */
  const restoreZoomAfterHold = useCallback(() => {
    if (!dragZoomMovedRef.current) return
    dragZoomMovedRef.current = false
    const from = dragZoomLastValueRef.current
    const to = dragZoomStartValueRef.current
    cancelAnimationFrame(zoomRestoreRafRef.current)
    if (Math.abs(from - to) < 0.01) return
    const started = performance.now()
    const durationMs = 220
    zoomRestoreActiveRef.current = true
    const tick = () => {
      const t = Math.min(1, (performance.now() - started) / durationMs)
      const eased = 1 - (1 - t) * (1 - t)
      camera.setZoom(from + (to - from) * eased)
      if (t < 1) {
        zoomRestoreRafRef.current = requestAnimationFrame(tick)
      } else {
        zoomRestoreActiveRef.current = false
      }
    }
    zoomRestoreRafRef.current = requestAnimationFrame(tick)
  }, [camera])

  const acquireWakeLock = useCallback(() => {
    const generation = wakeLockGenRef.current
    void navigator.wakeLock
      ?.request('screen')
      .then((sentinel) => {
        if (wakeLockGenRef.current !== generation) {
          // Released before the sentinel arrived (very short take).
          void sentinel.release().catch(() => undefined)
          return
        }
        wakeLockRef.current = sentinel
      })
      .catch(() => undefined)
  }, [])

  const releaseWakeLock = useCallback(() => {
    wakeLockGenRef.current += 1
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
        // Fire-and-forget GPS for this take — must not delay recording start.
        pendingFixRef.current = null
        if (locationTaggingRef.current) {
          pendingFixRef.current = getLocationFix()
        }
        acquireWakeLock()
        setRecording(true)
        setRecordingMode(nextRecordingMode)
        setRecordStartedAt(performance.now())
        if (storageState === 'critical') {
          showToast('Storage almost full — delete an old project soon')
        }
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
    [acquireWakeLock, camera, countdown, recording, showToast, storageState],
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
      // One end per take: stop() resolves asynchronously (duration is
      // measured), so a second caller (e.g. hide + return in quick
      // succession) must not re-enter and double-save the clip.
      if (endInFlightRef.current) return
      if (!recorderRef.current.isRecording && !recording) {
        // Pointer released while mic grant was still in flight.
        pointerIdRef.current = null
        camera.releaseMic()
        return
      }
      endInFlightRef.current = true
      pointerIdRef.current = null
      setRecording(false)
      setRecordingMode(null)
      // Detach this take's fix before any await so a quick next hold can own the ref.
      const pendingForThisTake = pendingFixRef.current
      pendingFixRef.current = null
      try {
        const result = await recorderRef.current.stop()
        if (!result) {
          showToast('Hold a bit longer')
          return
        }
        // Recording already elapsed while the fix ran; wait at most ~1.5s more.
        let fix: LocationFix | null = null
        if (pendingForThisTake) {
          fix = await Promise.race([
            pendingForThisTake,
            new Promise<null>((resolve) => {
              window.setTimeout(() => resolve(null), 1500)
            }),
          ])
        }
        await appendRecording(project.id, {
          ...result,
          ...(fix
            ? { lat: fix.lat, lng: fix.lng, locationAccuracyM: fix.accuracyM }
            : {}),
        })
        refresh()
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Save failed')
      } finally {
        endInFlightRef.current = false
        // stop() resolves only after the blob's duration is measured, so a
        // quick next hold may already be recording (or acquiring the mic) by
        // now — never strip the mic or wake lock from that newer session.
        if (!recorderRef.current.isRecording && !beginInFlightRef.current) {
          camera.releaseMic()
          releaseWakeLock()
        }
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

  const toggleLocationTagging = useCallback(() => {
    if (recording || countdown !== null) return
    if (locationTagging) {
      void (async () => {
        try {
          await setLocationTaggingEnabled(false)
          setLocationTagging(false)
          showToast('Location tagging off')
        } catch {
          showToast('Could not save the setting — try again')
        }
      })()
      return
    }
    // Tap is the user gesture that legitimizes the permission prompt.
    void (async () => {
      const fix = await getLocationFix()
      if (!fix) {
        showToast("Location unavailable — check the site's location permission")
        return
      }
      await setLocationTaggingEnabled(true)
      setLocationTagging(true)
      showToast('Location tagging on — new clips will be geotagged')
    })()
  }, [countdown, locationTagging, recording, showToast])

  const cleanupOnUnmount = useCallback(() => {
    clearCountdown()
    cancelAnimationFrame(zoomRestoreRafRef.current)
    recorderRef.current.cancel()
    releaseWakeLock()
  }, [clearCountdown, releaseWakeLock])

  // Release the camera whenever the app leaves the foreground — Android keeps
  // the privacy indicator (green dot) lit as long as any track is live. An
  // in-progress take is finished and saved first; the preview restarts when
  // the app becomes visible again.
  const visibilityActionRef = useRef<() => void>(() => undefined)
  visibilityActionRef.current = () => {
    if (document.hidden) {
      clearCountdown()
      if (recorderRef.current.isRecording || recording) {
        // MediaRecorder.stop() runs synchronously inside endRecord, so the
        // encoder has flushed by the time the tracks are stopped below; the
        // save itself continues in the background.
        void endRecord()
      }
      camera.stop()
      return
    }
    // Coming back to the foreground: restart the camera unconditionally.
    // Screen-off freezes the camera track at the OS level, and on some
    // Android paths no `hidden` event ever fires — a surviving stream would
    // keep previewing (and recording!) a single stale frame forever. If a
    // take was somehow still running on that frozen stream, save it first.
    void (async () => {
      if (recorderRef.current.isRecording || recording) {
        await endRecord()
      }
      camera.stop()
      // The app may have been hidden again while the take was finishing —
      // never reopen the camera (and relight the privacy dot) in background.
      if (document.hidden) return
      await camera.start()
      if (document.hidden) camera.stop()
    })()
  }

  const onVisibilityChange = useCallback(() => {
    visibilityActionRef.current()
  }, [])

  const attachCameraVideo = camera.videoRef
  const bindCameraVideo = useCallback(
    (element: HTMLVideoElement | null) => {
      if (!element) {
        document.removeEventListener('visibilitychange', onVisibilityChange)
        cleanupOnUnmount()
      } else {
        document.addEventListener('visibilitychange', onVisibilityChange)
      }
      attachCameraVideo(element)
    },
    [attachCameraVideo, cleanupOnUnmount, onVisibilityChange],
  )

  const needsPermission =
    camera.permission.status === 'denied' ||
    camera.permission.status === 'unsupported' ||
    (!!camera.error && !camera.isReady)

  return (
    <div className={`record-screen${recording ? ' is-recording' : ''}`}>
      <div
        ref={stageRef}
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
          // A second finger landing during an active hold must not reset the
          // drag-zoom state or start another take.
          if (pointerIdRef.current !== null) return
          // A new hold interrupts any snap-back still easing; the take starts
          // from the user's deliberate baseline zoom, not a mid-ramp value.
          cancelAnimationFrame(zoomRestoreRafRef.current)
          dragZoomMovedRef.current = false
          dragZoomPressYRef.current = event.clientY
          dragZoomStartValueRef.current = zoomBaselineRef.current ?? camera.zoom?.value ?? 1
          if (zoomRestoreActiveRef.current) {
            // Finish the interrupted ramp instantly so a motionless hold
            // still records from the baseline, not a mid-ramp zoom.
            zoomRestoreActiveRef.current = false
            camera.setZoom(dragZoomStartValueRef.current)
          }
          dragZoomStageHeightRef.current = event.currentTarget.clientHeight
          event.currentTarget.setPointerCapture(event.pointerId)
          void beginRecord(event.pointerId, 'hold')
        }}
        onPointerMove={(event) => {
          if (recordingMode !== 'hold') return
          if (pointerIdRef.current === null || pointerIdRef.current !== event.pointerId) return
          const zoom = camera.zoom
          if (!zoom) return
          const range = zoom.max - zoom.min
          if (range <= 0) return
          const stageHeight = dragZoomStageHeightRef.current || stageRef.current?.clientHeight || 1
          // Full zoom range over ~60% of stage height; drag up = zoom in.
          const travel = stageHeight * 0.6
          const deltaY = dragZoomPressYRef.current - event.clientY
          const next = Math.min(
            zoom.max,
            Math.max(zoom.min, dragZoomStartValueRef.current + (deltaY / travel) * range),
          )
          dragZoomMovedRef.current = true
          dragZoomLastValueRef.current = next
          camera.setZoom(next)
        }}
        onPointerUp={(event) => {
          if (recordingMode !== 'hands-free') {
            // Only the pointer that owns the hold may end the take and start
            // the snap-back — a stray second finger lifting must not zoom
            // out mid-recording.
            const ownsHold =
              pointerIdRef.current === null || pointerIdRef.current === event.pointerId
            void endRecord(event.pointerId)
            if (ownsHold) restoreZoomAfterHold()
          }
        }}
        onPointerCancel={(event) => {
          if (recordingMode !== 'hands-free') {
            const ownsHold =
              pointerIdRef.current === null || pointerIdRef.current === event.pointerId
            void endRecord(event.pointerId)
            if (ownsHold) restoreZoomAfterHold()
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
              <span className="record-pill-label">
                {recordingMode === 'hands-free' ? 'TAP TO STOP' : 'REC'}
              </span>
              <RecordTimer startedAt={recordStartedAt} className="record-elapsed" />
            </div>
          </div>
        ) : null}

        {countdown !== null ? (
          <div className="countdown-overlay" aria-live="assertive">
            <span className="countdown-number">{countdown}</span>
          </div>
        ) : null}

        {!recording && countdown === null && camera.isReady ? (
          <div className={`hold-hint${clips.length > 0 ? ' hold-hint-subtle' : ''}`}>
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
          <IconBack />
        </Link>
        <div className="record-meta">
          <strong>{project.name}</strong>
          <span className="record-total">{formatDuration(totalDurationMs)}</span>
          {storage && storageState !== 'ok' && !recording ? (
            <Link
              to="/"
              className={`storage-pill${storageState === 'critical' ? ' is-critical' : ''}`}
              aria-label="Device storage almost full — manage projects"
            >
              Storage {formatStoragePercent(storage.ratio)} full
            </Link>
          ) : null}
        </div>
        <div className="record-top-actions">
          {camera.torchAvailable ? (
            <button
              type="button"
              className={`btn-icon${camera.torchOn ? ' is-active' : ''}`}
              aria-label="Toggle flash"
              aria-pressed={camera.torchOn}
              disabled={recording || countdown !== null}
              onClick={() => void camera.setTorch(!camera.torchOn)}
            >
              <IconTorch on={camera.torchOn} />
            </button>
          ) : null}
          <button
            type="button"
            className="btn-icon"
            aria-label="Flip camera"
            disabled={!camera.canFlip || recording || countdown !== null}
            onClick={() => {
              // The baseline belongs to the previous lens; the new camera
              // starts from its own default zoom.
              cancelAnimationFrame(zoomRestoreRafRef.current)
              zoomBaselineRef.current = null
              dragZoomMovedRef.current = false
              void camera.flip()
            }}
          >
            <IconFlip />
          </button>
        </div>
      </div>

      {camera.zoom && zoomLevels.length > 0 ? (
        <div className="record-zoom" role="group" aria-label="Zoom">
          {zoomLevels.map((level) => {
            const isActive = activeZoomLevel !== null && Math.abs(activeZoomLevel - level) < 0.05
            return (
              <button
                key={level}
                type="button"
                className={`zoom-chip${isActive ? ' is-active' : ''}`}
                aria-pressed={isActive}
                disabled={countdown !== null}
                onClick={(event) => {
                  event.stopPropagation()
                  cancelAnimationFrame(zoomRestoreRafRef.current)
                  zoomBaselineRef.current = level
                  camera.setZoom(level)
                }}
              >
                {formatZoomLabel(level)}
              </button>
            )
          })}
        </div>
      ) : null}

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
            <IconEditor />
          </button>
          <button
            type="button"
            className="btn-icon"
            aria-label="Self-timer"
            disabled={recording || countdown !== null}
            onClick={startSelfTimer}
          >
            <IconTimer />
          </button>
          <button
            type="button"
            className={`btn-icon${locationTagging ? ' is-active' : ''}`}
            aria-label="Toggle location tagging"
            aria-pressed={locationTagging}
            disabled={recording || countdown !== null}
            onClick={toggleLocationTagging}
          >
            <IconLocation />
          </button>
          <button
            type="button"
            className="btn-icon"
            aria-label="Play project preview"
            disabled={recording || clips.length === 0}
            onClick={onPlay}
          >
            <IconPlay />
          </button>
          <button
            type="button"
            className="btn-icon"
            aria-label="Delete last clip"
            disabled={recording || clips.length === 0}
            onClick={deleteLastClip}
          >
            <IconDeleteLast />
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
