import type { Handle } from 'remix/ui'
import { on, ref } from 'remix/ui'
import '../styles/record.css'
import type { Camera } from '../lib/camera'
import { dragZoomValue } from '../lib/drag-zoom'
import { getLocationFix, type LocationFix } from '../lib/location'
import { pickRecordingMimeType, warmDurationProbe } from '../lib/media'
import {
  startMicLevelMonitor,
  warmMicMonitorContext,
  type MicLevelMonitor,
} from '../lib/mic-monitor'
import { reportError } from '../lib/error-reporting'
import { appendRecording, removeClip, undoLastDelete } from '../lib/project-actions'
import { HoldRecorder } from '../lib/recorder'
import {
  isScreenRecordingSupported,
  startScreenRecording,
  type ScreenRecordingSession,
} from '../lib/screen-recorder'
import { setLocationTaggingEnabled } from '../lib/storage'
import { captureLiveThumbs } from '../lib/thumbs'
import { formatZoomLabel, nearestZoomLevel, zoomChipLevels } from '../lib/zoom-chips'
import {
  formatStoragePercent,
  storageSeverity,
  type StorageSpace,
} from '../lib/storage-space'
import {
  effectiveDurationMs,
  formatDuration,
  type ClipRecord,
  type Project,
  type ProjectId,
} from '../lib/types'
import {
  IconBack,
  IconDeleteLast,
  IconEditor,
  IconFlip,
  IconLens,
  IconLocation,
  IconPlay,
  IconScreen,
  IconTimer,
  IconTorch,
} from './icons'
import { RecordTimer } from './record-timer'
import { isInteractiveTarget } from '../lib/keyboard'

type RecordingMode = 'hold' | 'hands-free'

/** Finger tremble tolerance before drag-to-zoom engages. */
const DRAG_ZOOM_DEADZONE_PX = 14

export interface ToastAction {
  actionLabel: string
  onAction: () => void
}

interface RecordScreenProps {
  project: Project
  /** Resolves the persisted project id, creating the project on the first
   * recorded clip (a "/project/new" project exists only in the URL). */
  ensureProjectId: () => Promise<ProjectId>
  clips: ClipRecord[]
  camera: Camera
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

export function RecordScreen(handle: Handle<RecordScreenProps>) {
  const { props } = handle
  const camera = props.camera

  const recorder = new HoldRecorder()
  let pointerId: number | null = null
  let spaceHeld = false
  /** True while a Space-started take is active: only keyup may end it, and
   * stray pointer events must not end the take or reset drag-zoom state. */
  let keyboardTake = false
  let beginInFlight = false
  let endInFlight = false
  let countdownTimer = 0
  let wakeLock: WakeLockSentinel | null = null
  let wakeLockGen = 0
  /** In-flight GPS fix for the current take; never shared across takes. */
  let pendingFix: Promise<LocationFix | null> | null = null
  /** Live audio-level watch for the current take (silent-mic warning). */
  let micMonitor: MicLevelMonitor | null = null

  let dragZoomPressY = 0
  let dragZoomStartValue = 0
  let dragZoomStageHeight = 0
  let dragZoomStageTop = 0
  /** Whether the current hold actually changed zoom (gates the snap-back). */
  let dragZoomMoved = false
  /** Last zoom value applied during the drag (ramp start for the snap-back). */
  let dragZoomLastValue = 0
  /** Zoom the user chose deliberately (chips) — what a take restores to. */
  let zoomBaseline: number | null = null
  let zoomRestoreRaf = 0
  /** True while the snap-back ramp is still easing toward the baseline. */
  let zoomRestoreActive = false
  let stageEl: HTMLDivElement | null = null

  let screenSession: ScreenRecordingSession | null = null
  /** True while the surface picker or a save is in flight. */
  let screenBusy = false

  let recording = false
  let recordingMode: RecordingMode | null = null
  let recordStartedAt = 0
  let countdown: number | null = null
  let screenRecording = false
  let screenRecordStartedAt = 0
  /** The current/last take's mic never rose above the silence floor. */
  let micSilent = false
  let locationTagging = props.locationTaggingEnabled ?? false

  const screenRecordingSupported = isScreenRecordingSupported()

  // Pre-warm the first take's one-time costs while the screen sits idle
  // (typically during the camera open): the mic-monitor AudioContext, the
  // MediaRecorder mime probe, and the duration probe's demux module
  // otherwise all land inside the first hold-to-record — profiling showed
  // them as the first-take stutter right at recording start/stop.
  let warmIdleHandle = 0
  let warmTimerHandle = 0
  const warmFirstTakePath = () => {
    warmMicMonitorContext()
    pickRecordingMimeType()
    warmDurationProbe()
  }
  if (typeof window.requestIdleCallback === 'function') {
    warmIdleHandle = window.requestIdleCallback(warmFirstTakePath, { timeout: 3000 })
  } else {
    warmTimerHandle = window.setTimeout(warmFirstTakePath, 1500)
  }

  const storageState = () => (props.storage ? storageSeverity(props.storage.ratio) : 'ok')

  const clearCountdown = () => {
    window.clearTimeout(countdownTimer)
    countdownTimer = 0
    countdown = null
    void handle.update()
  }

  /**
   * Thumbnail capture mirror: a DETACHED video element fed by the same
   * camera stream for the take's duration. Post-take thumbs are drawn from
   * it instead of the on-screen preview — reading back the on-screen
   * element kicks it out of Android's zero-copy overlay compositing path
   * for a frame, which is the post-take black flash. A detached element
   * was never in the compositor, so its readback can't blink anything.
   */
  let thumbMirror: HTMLVideoElement | null = null
  const stopThumbMirror = () => {
    const mirror = thumbMirror
    thumbMirror = null
    if (mirror) {
      mirror.srcObject = null
    }
  }
  const startThumbMirror = (stream: MediaStream) => {
    stopThumbMirror()
    const mirror = document.createElement('video')
    mirror.muted = true
    mirror.playsInline = true
    mirror.srcObject = stream
    void mirror.play().catch(() => undefined)
    thumbMirror = mirror
  }
  const captureTakeThumbs = async () => {
    const mirror = thumbMirror
    const fromMirror = mirror ? await captureLiveThumbs(mirror) : null
    // Ultra-short takes can end before the mirror got its first frame —
    // the on-screen element is the (blink-risking) fallback, still better
    // than the loader decoding the fresh blob behind the live preview.
    return fromMirror ?? captureLiveThumbs(camera.getVideoElement())
  }

  // Live zoom readout: updated imperatively (no component update) so
  // drag-to-zoom mid-recording never causes a re-render. Fades out shortly
  // after the value stops changing.
  let zoomHudEl: HTMLDivElement | null = null
  let zoomHudTimer = 0
  const showZoomHud = (value: number) => {
    const hud = zoomHudEl
    if (!hud) return
    hud.textContent = formatZoomLabel(value)
    hud.classList.add('is-visible')
    window.clearTimeout(zoomHudTimer)
    zoomHudTimer = window.setTimeout(() => {
      hud.classList.remove('is-visible')
    }, 900)
  }

  /**
   * OK Video behavior: drag-to-zoom only lasts for the take. When the finger
   * lifts, ease the lens back to the zoom the user had before recording.
   */
  const restoreZoomAfterHold = () => {
    if (!dragZoomMoved) return
    dragZoomMoved = false
    const from = dragZoomLastValue
    const to = dragZoomStartValue
    cancelAnimationFrame(zoomRestoreRaf)
    if (Math.abs(from - to) < 0.01) return
    const started = performance.now()
    const durationMs = 220
    zoomRestoreActive = true
    const tick = () => {
      const t = Math.min(1, (performance.now() - started) / durationMs)
      const eased = 1 - (1 - t) * (1 - t)
      const value = from + (to - from) * eased
      camera.setZoom(value)
      showZoomHud(value)
      if (t < 1) {
        zoomRestoreRaf = requestAnimationFrame(tick)
      } else {
        zoomRestoreActive = false
      }
    }
    zoomRestoreRaf = requestAnimationFrame(tick)
  }

  const releaseWakeLock = () => {
    wakeLockGen += 1
    void wakeLock?.release().catch(() => undefined)
    wakeLock = null
  }

  const acquireWakeLock = () => {
    // A successor take can start while the previous take's save is still in
    // flight (its cleanup defers to us) — release the previous sentinel
    // before acquiring ours, or it would be overwritten and leak, keeping
    // the screen awake indefinitely.
    releaseWakeLock()
    const generation = wakeLockGen
    void navigator.wakeLock
      ?.request('screen')
      .then((sentinel) => {
        if (wakeLockGen !== generation) {
          // Released before the sentinel arrived (very short take).
          void sentinel.release().catch(() => undefined)
          return
        }
        wakeLock = sentinel
      })
      .catch(() => undefined)
  }

  /** Stops the active screen capture and appends it as a clip. Idempotent. */
  const finishScreenRecord = async () => {
    const session = screenSession
    if (!session) return
    screenSession = null
    screenBusy = true
    screenRecording = false
    void handle.update()
    try {
      const result = await session.stop()
      if (!result) {
        props.showToast('Screen take was too short')
        return
      }
      await appendRecording(await props.ensureProjectId(), result)
      props.refresh()
      props.showToast('Screen clip added')
    } catch (err) {
      reportError(err, 'screen-record')
      props.showToast('Could not save the screen recording')
    } finally {
      screenBusy = false
    }
  }

  const startScreenRecord = () => {
    void (async () => {
      if (
        screenSession ||
        screenBusy ||
        recorder.isRecording ||
        props.interactionLocked ||
        countdown !== null
      ) {
        return
      }
      screenBusy = true
      try {
        const session = await startScreenRecording()
        screenSession = session
        screenRecordStartedAt = performance.now()
        screenRecording = true
        void handle.update()
        // The browser's own "Stop sharing" control must save too.
        session.setOnEnded(() => void finishScreenRecord())
      } catch (err) {
        // Cancelling the surface picker is a decision, not an error.
        if (!(err instanceof DOMException && err.name === 'NotAllowedError')) {
          props.showToast(err instanceof Error ? err.message : 'Screen recording failed')
        }
      } finally {
        screenBusy = false
      }
    })()
  }

  const beginRecord = async (
    nextPointerId: number | null,
    nextRecordingMode: RecordingMode,
  ): Promise<boolean> => {
    if (
      beginInFlight ||
      recording ||
      recorder.isRecording ||
      props.interactionLocked ||
      countdown !== null
    ) {
      return false
    }
    if (screenSession) {
      props.showToast('Stop the screen recording first')
      return false
    }
    if (!camera.getStream() || !camera.isReady) {
      props.showToast('Camera not ready')
      return false
    }

    beginInFlight = true
    pointerId = nextPointerId
    try {
      // Grab the mic only for this take so Brave/Android voice-to-text stays free while idle.
      await camera.enableMic()
      if (nextPointerId !== null && pointerId !== nextPointerId) {
        camera.releaseMic()
        return false
      }
      if (nextRecordingMode === 'hold' && nextPointerId !== null && pointerId === null) {
        camera.releaseMic()
        return false
      }
      // Re-check after the mic await — an overlay may have opened meanwhile.
      if (props.interactionLocked) {
        camera.releaseMic()
        return false
      }

      const stream = camera.getStream()
      if (!stream?.getAudioTracks().some((track) => track.readyState === 'live')) {
        throw new Error('Microphone unavailable')
      }

      const startedOk = recorder.start(stream)
      if (!startedOk) {
        pointerId = null
        // Never strip mic from an already-active recording owned by another start.
        if (!recorder.isRecording) camera.releaseMic()
        props.showToast('Still finishing the last clip')
        return false
      }
      // Fire-and-forget GPS for this take — must not delay recording start.
      pendingFix = null
      if (locationTagging) {
        pendingFix = getLocationFix()
      }
      startThumbMirror(stream)
      acquireWakeLock()
      // Watch the live mic level: users must learn about a dead mic while
      // holding, not after sharing a silent video (Sentry: near-zero clip
      // peaks on iOS). Warning state carries over between takes until a
      // take actually picks up sound.
      micMonitor?.stop()
      micMonitor = startMicLevelMonitor(stream, {
        onSilent: () => {
          micSilent = true
          void handle.update()
        },
        onSound: () => {
          micSilent = false
          void handle.update()
        },
      })
      recording = true
      recordingMode = nextRecordingMode
      recordStartedAt = performance.now()
      void handle.update()
      if (storageState() === 'critical') {
        props.showToast('Storage almost full — delete an old project soon')
      }
      return true
    } catch (err) {
      if (!recorder.isRecording) {
        camera.releaseMic()
        // A previous take whose deferred cleanup we pre-empted (its
        // finally saw our beginInFlight and skipped) must not leak its
        // monitor or wake lock when we then fail to start.
        micMonitor?.stop()
        micMonitor = null
        releaseWakeLock()
      }
      props.showToast(err instanceof Error ? err.message : 'Could not start recording')
      pointerId = null
      recordingMode = null
      void handle.update()
      return false
    } finally {
      beginInFlight = false
    }
  }

  const endRecord = async (endPointerId?: number) => {
    // Pointer events never end a Space-owned take (keyup does, and it
    // clears the flag before calling in).
    if (endPointerId !== undefined && keyboardTake) return
    if (endPointerId !== undefined && pointerId !== null && pointerId !== endPointerId) {
      return
    }
    // One end per take: stop() resolves asynchronously (duration is
    // measured), so a second caller (e.g. hide + return in quick
    // succession) must not re-enter and double-save the clip.
    if (endInFlight) return
    if (!recorder.isRecording && !recording) {
      // Pointer released while mic grant was still in flight.
      pointerId = null
      keyboardTake = false
      camera.releaseMic()
      return
    }
    endInFlight = true
    pointerId = null
    keyboardTake = false
    recording = false
    recordingMode = null
    void handle.update()
    // Detach this take's fix before any await so a quick next hold can own it.
    const pendingForThisTake = pendingFix
    pendingFix = null
    // Grab the poster/thumb from the detached mirror NOW (synchronous
    // draw at finger-lift) — decoding the recorded blob for thumbnails
    // while the preview runs blanks it on many Androids, and reading
    // back the on-screen element blinks its overlay path.
    const capturedThumbs = captureTakeThumbs().catch(() => null)
    try {
      const result = await recorder.stop()
      if (!result) {
        props.showToast('Hold a bit longer')
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
      await appendRecording(
        await props.ensureProjectId(),
        {
          ...result,
          ...(fix ? { lat: fix.lat, lng: fix.lng, locationAccuracyM: fix.accuracyM } : {}),
        },
        { capturedThumbs: await capturedThumbs },
      )
      props.refresh()
    } catch (err) {
      // Real store failures (quota, bad blob) must still reach Sentry as
      // handled exceptions — without the twin unhandled AbortError from tx.done.
      reportError(err, 'save-clip')
      props.showToast(err instanceof Error ? err.message : 'Save failed')
    } finally {
      endInFlight = false
      // stop() resolves only after the blob's duration is measured, so a
      // quick next hold may already be recording (or acquiring the mic) by
      // now — never strip the mic, monitor, or wake lock from that newer
      // session. Tearing the monitor down only after the encoder flushed
      // matters too: audio-graph churn while MediaRecorder still owned
      // the tracks flashed the preview black on some Androids.
      if (!recorder.isRecording && !beginInFlight) {
        micMonitor?.stop()
        micMonitor = null
        camera.releaseMic()
        releaseWakeLock()
        // A quick next hold already replaced the mirror via
        // startThumbMirror — only tear it down when this take is the last.
        stopThumbMirror()
      }
    }
  }

  const startSelfTimer = () => {
    if (recording || props.interactionLocked || countdown !== null) return
    if (screenSession) return
    if (!camera.getStream() || !camera.isReady) {
      props.showToast('Camera not ready')
      return
    }

    let next = 3
    countdown = next
    void handle.update()
    const tick = () => {
      next -= 1
      if (next <= 0) {
        countdownTimer = 0
        countdown = null
        void handle.update()
        void (async () => {
          const started = await beginRecord(null, 'hands-free')
          if (started) {
            props.showToast('Recording hands-free — tap the preview to stop')
          }
        })()
        return
      }
      countdown = next
      void handle.update()
      countdownTimer = window.setTimeout(tick, 1000)
    }
    countdownTimer = window.setTimeout(tick, 1000)
  }

  const deleteLastClip = () => {
    const lastClip = props.clips.at(-1)
    if (!lastClip) {
      props.showToast('No clips yet')
      return
    }
    void (async () => {
      await removeClip(lastClip.id)
      props.refresh()
      props.showToast('Last clip deleted', {
        actionLabel: 'Undo',
        onAction: () => {
          void (async () => {
            await undoLastDelete(props.project.id)
            props.refresh()
            props.showToast('Clip restored')
          })()
        },
      })
    })()
  }

  const toggleLocationTagging = () => {
    if (recording || countdown !== null) return
    if (locationTagging) {
      void (async () => {
        try {
          await setLocationTaggingEnabled(false)
          locationTagging = false
          void handle.update()
          props.showToast('Location tagging off')
        } catch {
          props.showToast('Could not save the setting — try again')
        }
      })()
      return
    }
    // Tap is the user gesture that legitimizes the permission prompt.
    void (async () => {
      const fix = await getLocationFix()
      if (!fix) {
        props.showToast("Location unavailable — check the site's location permission")
        return
      }
      try {
        await setLocationTaggingEnabled(true)
        locationTagging = true
        void handle.update()
        props.showToast('Location tagging on — new clips will be geotagged')
      } catch {
        props.showToast('Could not save the setting — try again')
      }
    })()
  }

  const cleanupOnUnmount = () => {
    if (warmIdleHandle) window.cancelIdleCallback?.(warmIdleHandle)
    window.clearTimeout(warmTimerHandle)
    window.clearTimeout(countdownTimer)
    countdownTimer = 0
    cancelAnimationFrame(zoomRestoreRaf)
    micMonitor?.stop()
    micMonitor = null
    recorder.cancel()
    stopThumbMirror()
    // Leaving the screen mustn't lose an active screen take — save it.
    void finishScreenRecord()
    releaseWakeLock()
  }

  // Release the camera whenever the app leaves the foreground — Android keeps
  // the privacy indicator (green dot) lit as long as any track is live. An
  // in-progress take is finished and saved first; the preview restarts when
  // the app becomes visible again.
  const onVisibilityChange = () => {
    if (document.hidden) {
      clearCountdown()
      // The warning describes takes from the session being left behind;
      // returning starts fresh with a restarted camera (and mic, on iOS).
      micSilent = false
      void handle.update()
      if (recorder.isRecording || recording) {
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
      if (recorder.isRecording || recording) {
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

  // Desktop keyboard support (the app is designed for phones; this keeps the
  // desktop experience respectable). Closures read live setup-scope state, so
  // no re-binding is ever needed.
  const onWindowKeyDown = (event: KeyboardEvent) => {
    if (event.repeat || props.interactionLocked) return
    if (isInteractiveTarget(event)) return
    switch (event.code) {
      case 'Space': {
        event.preventDefault()
        if (countdown !== null) {
          clearCountdown()
          props.showToast('Timer canceled')
          return
        }
        if (recording) {
          // Hands-free (or a stuck keyboard hold): stop on press.
          if (recordingMode === 'hands-free') void endRecord()
          return
        }
        // Like a pointer hold: interrupt any zoom snap-back still easing
        // and record from the deliberate baseline, not a mid-ramp value.
        cancelAnimationFrame(zoomRestoreRaf)
        if (zoomRestoreActive) {
          zoomRestoreActive = false
          camera.setZoom(zoomBaseline ?? camera.zoom?.value ?? 1)
        }
        spaceHeld = true
        keyboardTake = true
        void beginRecord(null, 'hold').then((started) => {
          if (!started) {
            keyboardTake = false
            return
          }
          // Space was released while the mic grant was in flight.
          if (!spaceHeld) {
            keyboardTake = false
            void endRecord()
          }
        })
        return
      }
      case 'KeyE': {
        if (recording) return
        camera.releaseMic()
        props.onOpenEditor()
        return
      }
      case 'KeyP': {
        if (!recording && props.clips.length > 0) props.onPlay()
        return
      }
      case 'KeyF': {
        if (!recording && camera.canFlip && countdown === null) void camera.flip()
        return
      }
      case 'KeyT': {
        if (!recording && countdown === null) startSelfTimer()
        return
      }
      case 'KeyS': {
        if (recording || countdown !== null) return
        if (screenSession) void finishScreenRecord()
        else if (screenRecordingSupported) startScreenRecord()
        return
      }
      case 'Backspace':
      case 'Delete': {
        // Without this, Backspace can also trigger history navigation.
        event.preventDefault()
        if (!recording && props.clips.length > 0) deleteLastClip()
        return
      }
      default:
        return
    }
  }
  const onWindowKeyUp = (event: KeyboardEvent) => {
    if (event.code !== 'Space') return
    spaceHeld = false
    // Only a keyboard-started hold (no owning pointer) ends on keyup.
    if (recording && recordingMode === 'hold' && pointerId === null) {
      keyboardTake = false
      void endRecord()
    }
  }

  const bindCameraVideo = (element: HTMLVideoElement, signal: AbortSignal) => {
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('keydown', onWindowKeyDown)
    window.addEventListener('keyup', onWindowKeyUp)
    // Registered before camera.attachVideo's own abort listener so an active
    // take is finished/saved before the camera stream is stopped.
    signal.addEventListener('abort', () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('keydown', onWindowKeyDown)
      window.removeEventListener('keyup', onWindowKeyUp)
      cleanupOnUnmount()
    })
    camera.attachVideo(element, signal)
  }

  return () => {
    const { project, clips, storage, onOpenEditor, onOpenExport, onPlay } = props
    const totalDurationMs = clips.reduce((sum, clip) => sum + effectiveDurationMs(clip), 0)
    const zoomLevels = camera.zoom ? zoomChipLevels(camera.zoom) : []
    const activeZoomLevel =
      camera.zoom && zoomLevels.length > 0 ? nearestZoomLevel(zoomLevels, camera.zoom.value) : null
    // Ultra-wide/telephoto are usually separate rear cameras on Android — a
    // lens chip is the only way to reach 0.5× when zoom can't go below 1×.
    const showLensChip = camera.facing === 'environment' && camera.rearLensCount > 1
    const severity = storageState()

    const needsPermission =
      camera.permission.status === 'denied' ||
      camera.permission.status === 'unsupported' ||
      (!!camera.error && !camera.isReady)

    return (
      <div className={`record-screen${recording ? ' is-recording' : ''}`}>
        <div
          className="record-stage"
          mix={[
            ref((node) => {
              stageEl = node as HTMLDivElement
            }),
            on('pointerdown', (event) => {
              if (event.button !== 0) return
              // While recording the screen, the whole stage is the stop button
              // (matching the hands-free "tap to stop" language).
              if (screenSession) {
                void finishScreenRecord()
                return
              }
              if (countdown !== null) {
                clearCountdown()
                props.showToast('Timer canceled')
                return
              }
              if (recording && recordingMode === 'hands-free') {
                void endRecord()
                return
              }
              // A Space-owned take ends on Space keyup only; taps must not
              // disturb it or its zoom state.
              if (keyboardTake) return
              // A second finger landing during an active hold must not reset the
              // drag-zoom state or start another take.
              if (pointerId !== null) return
              // A new hold interrupts any snap-back still easing; the take starts
              // from the user's deliberate baseline zoom, not a mid-ramp value.
              cancelAnimationFrame(zoomRestoreRaf)
              dragZoomMoved = false
              dragZoomPressY = event.clientY
              dragZoomStartValue = zoomBaseline ?? camera.zoom?.value ?? 1
              if (zoomRestoreActive) {
                // Finish the interrupted ramp instantly so a motionless hold
                // still records from the baseline, not a mid-ramp zoom.
                zoomRestoreActive = false
                camera.setZoom(dragZoomStartValue)
              }
              const stage = event.currentTarget as HTMLDivElement
              const stageRect = stage.getBoundingClientRect()
              dragZoomStageHeight = stageRect.height
              dragZoomStageTop = stageRect.top
              stage.setPointerCapture(event.pointerId)
              void beginRecord(event.pointerId, 'hold')
            }),
            on('pointermove', (event) => {
              if (recordingMode !== 'hold') return
              if (pointerId === null || pointerId !== event.pointerId) return
              const zoom = camera.zoom
              if (!zoom) return
              if (zoom.max - zoom.min <= 0) return
              // Dead zone: natural finger tremble while holding to record must
              // not start zooming. Once crossed, re-anchor so zoom ramps from
              // the current finger position without a jump.
              if (!dragZoomMoved) {
                if (Math.abs(event.clientY - dragZoomPressY) < DRAG_ZOOM_DEADZONE_PX) {
                  return
                }
                dragZoomPressY = event.clientY
              }
              // Range-anchored mapping (see dragZoomValue's contract): dragging
              // to the top of the stage reaches MAX zoom, to the bottom reaches
              // MIN — except presses within ~20% of an edge, which keep a
              // minimum ramp for control and cap partway at that edge.
              const next = dragZoomValue({
                anchorY: dragZoomPressY,
                clientY: event.clientY,
                stageTop: dragZoomStageTop,
                stageHeight: dragZoomStageHeight || stageEl?.clientHeight || 1,
                start: dragZoomStartValue,
                min: zoom.min,
                max: zoom.max,
              })
              dragZoomMoved = true
              dragZoomLastValue = next
              camera.setZoom(next)
              showZoomHud(next)
            }),
            on('pointerup', (event) => {
              if (keyboardTake) return
              if (recordingMode !== 'hands-free') {
                // Only the pointer that owns the hold may end the take and start
                // the snap-back — a stray second finger lifting must not zoom
                // out mid-recording.
                const ownsHold = pointerId === null || pointerId === event.pointerId
                void endRecord(event.pointerId)
                if (ownsHold) restoreZoomAfterHold()
              }
            }),
            on('pointercancel', (event) => {
              if (keyboardTake) return
              if (recordingMode !== 'hands-free') {
                const ownsHold = pointerId === null || pointerId === event.pointerId
                void endRecord(event.pointerId)
                if (ownsHold) restoreZoomAfterHold()
              }
            }),
            on('contextmenu', (event) => event.preventDefault()),
          ]}
        >
          <video
            className={`camera-video${camera.facing === 'user' ? ' mirror' : ''}`}
            muted
            playsInline
            autoPlay
            mix={ref((node, signal) => bindCameraVideo(node as HTMLVideoElement, signal))}
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

          {screenRecording ? (
            <div className="record-overlay">
              <div className="record-pill" aria-live="polite">
                <span className="record-dot" />
                <span className="record-pill-label">SCREEN — TAP TO STOP</span>
                <RecordTimer startedAt={screenRecordStartedAt} className="record-elapsed" />
              </div>
            </div>
          ) : null}

          {countdown !== null ? (
            <div className="countdown-overlay" aria-live="assertive">
              <span className="countdown-number">{countdown}</span>
            </div>
          ) : null}

          {!recording && !screenRecording && countdown === null && camera.isReady ? (
            <div className={`hold-hint${clips.length > 0 ? ' hold-hint-subtle' : ''}`}>
              <strong>Hold anywhere</strong>
              <span>release to stop</span>
            </div>
          ) : null}

          <div
            className="zoom-hud"
            aria-hidden="true"
            mix={ref((node, signal) => {
              zoomHudEl = node as HTMLDivElement
              signal.addEventListener('abort', () => {
                zoomHudEl = null
                window.clearTimeout(zoomHudTimer)
              })
            })}
          />

          {needsPermission ? (
            <div className="permission-panel">
              <div>
                <h2>Camera access</h2>
                <p>
                  {camera.error ??
                    camera.permission.message ??
                    'Allow camera to preview. Recording needs the microphone too.'}
                </p>
                <button
                  type="button"
                  className="btn btn-primary"
                  mix={on('click', () => void camera.start())}
                >
                  Try again
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="record-top">
          <a
            href="/"
            className="btn-icon"
            aria-label="Back to projects"
            mix={on('click', (event) => {
              // Modifier/middle clicks open a new tab and leave this page
              // mounted — don't tear down the live camera session for them.
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
              if (event.button !== 0) return
              cleanupOnUnmount()
            })}
          >
            <IconBack />
          </a>
          <div className="record-meta">
            <strong>{project.name}</strong>
            <span className="record-total">{formatDuration(totalDurationMs)}</span>
            {storage && severity !== 'ok' && !recording ? (
              <a
                href="/"
                className={`storage-pill${severity === 'critical' ? ' is-critical' : ''}`}
                aria-label="Device storage almost full — manage projects"
              >
                Storage {formatStoragePercent(storage.ratio)} full
              </a>
            ) : null}
            {camera.micPermission === 'denied' && !recording ? (
              <span
                className="storage-pill is-critical"
                role="status"
                aria-label="Microphone blocked — recordings need sound"
              >
                Mic blocked — allow it in site settings
              </span>
            ) : null}
            {micSilent && camera.micPermission !== 'denied' ? (
              <span
                className="storage-pill is-critical"
                role="status"
                aria-label="Microphone is not picking up sound"
              >
                Mic isn&rsquo;t picking up sound
              </span>
            ) : null}
          </div>
          <div className="record-top-actions">
            {screenRecordingSupported ? (
              <button
                type="button"
                className={`btn-icon${screenRecording ? ' is-active' : ''}`}
                aria-label={screenRecording ? 'Stop screen recording' : 'Record your screen'}
                aria-pressed={screenRecording}
                disabled={recording || countdown !== null}
                mix={on('click', () => {
                  if (screenSession) void finishScreenRecord()
                  else startScreenRecord()
                })}
              >
                <IconScreen on={screenRecording} />
              </button>
            ) : null}
            {camera.torchAvailable ? (
              <button
                type="button"
                className={`btn-icon${camera.torchOn ? ' is-active' : ''}`}
                aria-label="Toggle flash"
                aria-pressed={camera.torchOn}
                disabled={recording || countdown !== null}
                mix={on('click', () => void camera.setTorch(!camera.torchOn))}
              >
                <IconTorch on={camera.torchOn} />
              </button>
            ) : null}
            <button
              type="button"
              className="btn-icon"
              aria-label="Flip camera"
              disabled={!camera.canFlip || recording || countdown !== null}
              mix={on('click', () => {
                // The baseline belongs to the previous lens; the new camera
                // starts from its own default zoom.
                cancelAnimationFrame(zoomRestoreRaf)
                zoomBaseline = null
                dragZoomMoved = false
                void camera.flip()
              })}
            >
              <IconFlip />
            </button>
          </div>
        </div>

        {(camera.zoom && zoomLevels.length > 0) || showLensChip ? (
          <div className="record-zoom" role="group" aria-label="Zoom and lens">
            {showLensChip ? (
              <button
                type="button"
                className="zoom-chip lens-chip"
                aria-label={`Switch rear lens (${camera.rearLensIndex + 1} of ${camera.rearLensCount})`}
                disabled={recording || countdown !== null || !camera.isReady}
                mix={on('click', (event) => {
                  event.stopPropagation()
                  // Each lens has its own zoom range and default.
                  cancelAnimationFrame(zoomRestoreRaf)
                  zoomBaseline = null
                  dragZoomMoved = false
                  void camera
                    .switchRearLens()
                    .then(() => {
                      const range = camera.getZoom()
                      if (range) showZoomHud(range.value)
                    })
                    .catch(() => undefined)
                })}
              >
                <IconLens size={14} />
                {camera.rearLensIndex + 1}/{camera.rearLensCount}
              </button>
            ) : null}
            {zoomLevels.map((level) => {
              const isActive = activeZoomLevel !== null && Math.abs(activeZoomLevel - level) < 0.05
              return (
                <button
                  key={level}
                  type="button"
                  className={`zoom-chip${isActive ? ' is-active' : ''}`}
                  aria-pressed={isActive}
                  disabled={countdown !== null}
                  mix={on('click', (event) => {
                    event.stopPropagation()
                    cancelAnimationFrame(zoomRestoreRaf)
                    zoomBaseline = level
                    camera.setZoom(level)
                    showZoomHud(level)
                  })}
                >
                  {formatZoomLabel(level)}
                </button>
              )
            })}
          </div>
        ) : null}

        <div className="key-hints" aria-hidden="true">
          Hold <kbd>Space</kbd> record · <kbd>F</kbd> flip · <kbd>T</kbd> timer ·{' '}
          {screenRecordingSupported ? (
            <>
              <kbd>S</kbd> screen ·{' '}
            </>
          ) : null}
          <kbd>E</kbd> editor · <kbd>P</kbd> play · <kbd>⌫</kbd> delete last
        </div>

        <div className="record-dock">
          <div className="record-tools">
            <button
              type="button"
              className="btn-icon"
              aria-label="Open editor"
              disabled={recording || screenRecording}
              mix={on('click', () => {
                camera.releaseMic()
                onOpenEditor()
              })}
            >
              <IconEditor />
            </button>
            <button
              type="button"
              className="btn-icon"
              aria-label="Self-timer"
              disabled={recording || screenRecording || countdown !== null}
              mix={on('click', startSelfTimer)}
            >
              <IconTimer />
            </button>
            <button
              type="button"
              className={`btn-icon${locationTagging ? ' is-active' : ''}`}
              aria-label="Toggle location tagging"
              aria-pressed={locationTagging}
              disabled={recording || countdown !== null}
              mix={on('click', toggleLocationTagging)}
            >
              <IconLocation />
            </button>
            <button
              type="button"
              className="btn-icon"
              aria-label="Play project preview"
              disabled={recording || screenRecording || clips.length === 0}
              mix={on('click', () => onPlay())}
            >
              <IconPlay />
            </button>
            <button
              type="button"
              className="btn-icon"
              aria-label="Delete last clip"
              disabled={recording || screenRecording || clips.length === 0}
              mix={on('click', deleteLastClip)}
            >
              <IconDeleteLast />
            </button>
          </div>
          <button
            type="button"
            className="go-button"
            disabled={clips.length === 0 || recording || screenRecording}
            mix={on('click', () => onOpenExport())}
          >
            Go
          </button>
        </div>
      </div>
    )
  }
}
