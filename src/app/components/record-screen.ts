/**
 * Camera surface: hold-to-record, drag-to-zoom, self-timer, screen
 * recording, torch/flip/lens controls, and the record dock.
 *
 * The skeleton is built ONCE; state changes sync imperatively (classes,
 * hidden flags, text) so nothing re-renders per frame while recording —
 * re-rendering the whole screen is what made capture drop frames.
 */

import { define, h, KvElement } from '../dom.ts'
import type { Camera } from '../lib/camera.ts'
import { dragZoomValue } from '../lib/drag-zoom.ts'
import { reportError } from '../lib/error-reporting.ts'
import { isInteractiveTarget } from '../lib/keyboard.ts'
import { getLocationFix, type LocationFix } from '../lib/location.ts'
import { startMicLevelMonitor, type MicLevelMonitor } from '../lib/mic-monitor.ts'
import { appendRecording, removeClip, undoLastDelete } from '../lib/project-actions.ts'
import { HoldRecorder } from '../lib/recorder.ts'
import {
  isScreenRecordingSupported,
  startScreenRecording,
  type ScreenRecordingSession,
} from '../lib/screen-recorder.ts'
import { setLocationTaggingEnabled } from '../lib/storage.ts'
import {
  formatStoragePercent,
  storageSeverity,
  type StorageSpace,
} from '../lib/storage-space.ts'
import { captureLiveThumbs } from '../lib/thumbs.ts'
import {
  effectiveDurationMs,
  formatDuration,
  type ClipRecord,
  type Project,
  type ProjectId,
} from '../lib/types.ts'
import { formatZoomLabel, nearestZoomLevel, zoomChipLevels } from '../lib/zoom-chips.ts'
import {
  iconBack,
  iconDeleteLast,
  iconEditor,
  iconFlip,
  iconLens,
  iconLocation,
  iconPlay,
  iconScreen,
  iconTimer,
  iconTorch,
} from './icons.ts'

/** Finger tremble tolerance before drag-to-zoom engages. */
const DRAG_ZOOM_DEADZONE_PX = 14

type RecordingMode = 'hold' | 'hands-free'

export interface ToastAction {
  actionLabel: string
  onAction: () => void
}

export type ShowToast = (message: string, action?: ToastAction) => void

export interface RecordScreenProps {
  project: Project
  clips: ClipRecord[]
  camera: Camera
  /** Device storage estimate for the almost-full warning. */
  storage: StorageSpace | null
  /** Opt-in: tag new clips with device location (persisted setting). */
  locationTaggingEnabled?: boolean
  /** True while an overlay (export, preview, onboarding) should block capture. */
  interactionLocked: boolean
  /** Resolves the persisted project id, creating the project on the first
   * recorded clip (a "/project/new" project exists only in the URL). */
  ensureProjectId: () => Promise<ProjectId>
  onOpenEditor: () => void
  onOpenExport: () => void
  onPlay: () => void
  showToast: ShowToast
  refresh: () => void
}

interface RecordScreenEls {
  root: HTMLDivElement
  stage: HTMLDivElement
  video: HTMLVideoElement
  recordOverlay: HTMLDivElement
  recordPillLabel: HTMLSpanElement
  recordElapsed: HTMLSpanElement
  screenOverlay: HTMLDivElement
  screenElapsed: HTMLSpanElement
  countdownOverlay: HTMLDivElement
  countdownNumber: HTMLSpanElement
  holdHint: HTMLDivElement
  zoomHud: HTMLDivElement
  permissionPanel: HTMLDivElement
  permissionMessage: HTMLParagraphElement
  top: HTMLDivElement
  projectName: HTMLElement
  totalDuration: HTMLSpanElement
  storagePill: HTMLAnchorElement
  micBlockedPill: HTMLSpanElement
  micSilentPill: HTMLSpanElement
  screenButton: HTMLButtonElement
  torchButton: HTMLButtonElement
  flipButton: HTMLButtonElement
  zoomRow: HTMLDivElement
  keyHints: HTMLDivElement
  editorButton: HTMLButtonElement
  timerButton: HTMLButtonElement
  locationButton: HTMLButtonElement
  playButton: HTMLButtonElement
  deleteButton: HTMLButtonElement
  goButton: HTMLButtonElement
  dock: HTMLDivElement
}

export class KvRecordScreen extends KvElement<RecordScreenProps> {
  // ---- take state (mirrors the original module-scope closure state) ----
  recorder = new HoldRecorder()
  pointerId: number | null = null
  spaceHeld = false
  /** True while a Space-started take is active: only keyup may end it. */
  keyboardTake = false
  beginInFlight = false
  endInFlight = false
  countdownTimer = 0
  wakeLock: WakeLockSentinel | null = null
  wakeLockGen = 0
  /** In-flight GPS fix for the current take; never shared across takes. */
  pendingFix: Promise<LocationFix | null> | null = null
  /** Live audio-level watch for the current take (silent-mic warning). */
  micMonitor: MicLevelMonitor | null = null

  dragZoomPressY = 0
  dragZoomStartValue = 0
  dragZoomStageHeight = 0
  dragZoomStageTop = 0
  dragZoomMoved = false
  dragZoomLastValue = 0
  /** Zoom the user chose deliberately (chips) — what a take restores to. */
  zoomBaseline: number | null = null
  zoomRestoreRaf = 0
  zoomRestoreActive = false

  screenSession: ScreenRecordingSession | null = null
  screenBusy = false

  recording = false
  recordingMode: RecordingMode | null = null
  recordStartedAt = 0
  countdown: number | null = null
  screenRecording = false
  screenRecordStartedAt = 0
  micSilent = false
  locationTagging = false

  thumbMirror: HTMLVideoElement | null = null
  zoomHudTimer = 0
  elapsedRaf = 0
  #chipSignature: string | null = null

  // ---- element refs (assigned in render, before anything reads them) ----
  els = {} as RecordScreenEls

  get camera(): Camera {
    return this.props.camera
  }

  /** Prop changes sync imperatively — the skeleton (and the live camera
   * preview inside it) must never rebuild. */
  override update(): void {
    this.sync()
  }

  storageState() {
    return this.props.storage ? storageSeverity(this.props.storage.ratio) : 'ok'
  }

  clearCountdown() {
    window.clearTimeout(this.countdownTimer)
    this.countdownTimer = 0
    this.countdown = null
    this.sync()
  }

  /**
   * Thumbnail capture mirror: a DETACHED video element fed by the same
   * camera stream for the take's duration. Post-take thumbs are drawn from
   * it instead of the on-screen preview — reading back the on-screen
   * element kicks it out of Android's zero-copy overlay compositing path
   * for a frame (the post-take black flash).
   */
  stopThumbMirror() {
    const mirror = this.thumbMirror
    this.thumbMirror = null
    if (mirror) mirror.srcObject = null
  }

  startThumbMirror(stream: MediaStream): void {
    this.stopThumbMirror()
    const mirror = document.createElement('video')
    mirror.muted = true
    mirror.playsInline = true
    mirror.srcObject = stream
    void mirror.play().catch(() => undefined)
    this.thumbMirror = mirror
  }

  async captureTakeThumbs() {
    const mirror = this.thumbMirror
    const fromMirror = mirror ? await captureLiveThumbs(mirror) : null
    // Ultra-short takes can end before the mirror got its first frame —
    // the on-screen element is the (blink-risking) fallback.
    return fromMirror ?? captureLiveThumbs(this.camera.getVideoElement())
  }

  /** Live zoom readout, updated imperatively; fades shortly after changes. */
  showZoomHud(value: number): void {
    const hud = this.els.zoomHud
    if (!hud) return
    hud.textContent = formatZoomLabel(value)
    hud.classList.add('is-visible')
    window.clearTimeout(this.zoomHudTimer)
    this.zoomHudTimer = window.setTimeout(() => {
      hud.classList.remove('is-visible')
    }, 900)
  }

  /**
   * OK Video behavior: drag-to-zoom only lasts for the take. When the finger
   * lifts, ease the lens back to the zoom the user had before recording.
   */
  restoreZoomAfterHold() {
    if (!this.dragZoomMoved) return
    this.dragZoomMoved = false
    const from = this.dragZoomLastValue
    const to = this.dragZoomStartValue
    cancelAnimationFrame(this.zoomRestoreRaf)
    if (Math.abs(from - to) < 0.01) return
    const started = performance.now()
    const durationMs = 220
    this.zoomRestoreActive = true
    const tick = () => {
      const t = Math.min(1, (performance.now() - started) / durationMs)
      const eased = 1 - (1 - t) * (1 - t)
      const value = from + (to - from) * eased
      this.camera.setZoom(value)
      this.showZoomHud(value)
      if (t < 1) {
        this.zoomRestoreRaf = requestAnimationFrame(tick)
      } else {
        this.zoomRestoreActive = false
      }
    }
    this.zoomRestoreRaf = requestAnimationFrame(tick)
  }

  releaseWakeLock() {
    this.wakeLockGen += 1
    void this.wakeLock?.release().catch(() => undefined)
    this.wakeLock = null
  }

  acquireWakeLock() {
    // A successor take can start while the previous take's save is still in
    // flight — release the previous sentinel before acquiring ours.
    this.releaseWakeLock()
    const generation = this.wakeLockGen
    void navigator.wakeLock
      ?.request('screen')
      .then((sentinel) => {
        if (this.wakeLockGen !== generation) {
          void sentinel.release().catch(() => undefined)
          return
        }
        this.wakeLock = sentinel
      })
      .catch(() => undefined)
  }

  /** Stops the active screen capture and appends it as a clip. Idempotent. */
  async finishScreenRecord() {
    const session = this.screenSession
    if (!session) return
    this.screenSession = null
    this.screenBusy = true
    this.screenRecording = false
    this.sync()
    try {
      const result = await session.stop()
      if (!result) {
        this.props.showToast('Screen take was too short')
        return
      }
      await appendRecording(await this.props.ensureProjectId(), result)
      this.props.refresh()
      this.props.showToast('Screen clip added')
    } catch (err) {
      reportError(err, 'screen-record')
      this.props.showToast('Could not save the screen recording')
    } finally {
      this.screenBusy = false
    }
  }

  startScreenRecord() {
    void (async () => {
      if (
        this.screenSession ||
        this.screenBusy ||
        this.recorder.isRecording ||
        this.props.interactionLocked ||
        this.countdown !== null
      ) {
        return
      }
      this.screenBusy = true
      try {
        const session = await startScreenRecording()
        this.screenSession = session
        this.screenRecordStartedAt = performance.now()
        this.screenRecording = true
        this.sync()
        // The browser's own "Stop sharing" control must save too.
        session.setOnEnded(() => void this.finishScreenRecord())
      } catch (err) {
        // Cancelling the surface picker is a decision, not an error.
        if (!(err instanceof DOMException && err.name === 'NotAllowedError')) {
          this.props.showToast(err instanceof Error ? err.message : 'Screen recording failed')
        }
      } finally {
        this.screenBusy = false
      }
    })()
  }

  async beginRecord(
    nextPointerId: number | null,
    nextRecordingMode: RecordingMode,
  ): Promise<boolean> {
    const camera = this.camera
    if (
      this.beginInFlight ||
      this.recording ||
      this.recorder.isRecording ||
      this.props.interactionLocked ||
      this.countdown !== null
    ) {
      return false
    }
    if (this.screenSession) {
      this.props.showToast('Stop the screen recording first')
      return false
    }
    if (!camera.getStream() || !camera.isReady) {
      this.props.showToast('Camera not ready')
      return false
    }

    this.beginInFlight = true
    this.pointerId = nextPointerId
    try {
      // Grab the mic only for this take so Android voice-to-text stays free while idle.
      await camera.enableMic()
      if (nextPointerId !== null && this.pointerId !== nextPointerId) {
        camera.releaseMic()
        return false
      }
      if (nextRecordingMode === 'hold' && nextPointerId !== null && this.pointerId === null) {
        camera.releaseMic()
        return false
      }
      // Re-check after the mic await — an overlay may have opened meanwhile.
      if (this.props.interactionLocked) {
        camera.releaseMic()
        return false
      }

      const stream = camera.getStream()
      if (!stream?.getAudioTracks().some((track) => track.readyState === 'live')) {
        throw new Error('Microphone unavailable')
      }

      const startedOk = this.recorder.start(stream)
      if (!startedOk) {
        this.pointerId = null
        // Never strip mic from an already-active recording owned by another start.
        if (!this.recorder.isRecording) camera.releaseMic()
        this.props.showToast('Still finishing the last clip')
        return false
      }
      // Fire-and-forget GPS for this take — must not delay recording start.
      this.pendingFix = null
      if (this.locationTagging) {
        this.pendingFix = getLocationFix()
      }
      this.startThumbMirror(stream)
      this.acquireWakeLock()
      // Watch the live mic level: users must learn about a dead mic while
      // holding, not after sharing a silent video. Warning state carries
      // over between takes until a take actually picks up sound.
      this.micMonitor?.stop()
      this.micMonitor = startMicLevelMonitor(stream, {
        onSilent: () => {
          this.micSilent = true
          this.sync()
        },
        onSound: () => {
          this.micSilent = false
          this.sync()
        },
      })
      this.recording = true
      this.recordingMode = nextRecordingMode
      this.recordStartedAt = performance.now()
      this.sync()
      if (this.storageState() === 'critical') {
        this.props.showToast('Storage almost full — delete an old project soon')
      }
      return true
    } catch (err) {
      if (!this.recorder.isRecording) {
        camera.releaseMic()
        // A previous take whose deferred cleanup we pre-empted must not
        // leak its monitor or wake lock when we then fail to start.
        this.micMonitor?.stop()
        this.micMonitor = null
        this.releaseWakeLock()
      }
      this.props.showToast(err instanceof Error ? err.message : 'Could not start recording')
      this.pointerId = null
      this.recordingMode = null
      this.sync()
      return false
    } finally {
      this.beginInFlight = false
    }
  }

  async endRecord(endPointerId?: number): Promise<void> {
    // Pointer events never end a Space-owned take (keyup does, and it
    // clears the flag before calling in).
    if (endPointerId !== undefined && this.keyboardTake) return
    if (endPointerId !== undefined && this.pointerId !== null && this.pointerId !== endPointerId) {
      return
    }
    // One end per take: stop() resolves asynchronously, so a second caller
    // must not re-enter and double-save the clip.
    if (this.endInFlight) return
    if (!this.recorder.isRecording && !this.recording) {
      // Pointer released while mic grant was still in flight.
      this.pointerId = null
      this.keyboardTake = false
      this.camera.releaseMic()
      return
    }
    this.endInFlight = true
    this.pointerId = null
    this.keyboardTake = false
    this.recording = false
    this.recordingMode = null
    this.sync()
    // Detach this take's fix before any await so a quick next hold can own it.
    const pendingForThisTake = this.pendingFix
    this.pendingFix = null
    // Grab the poster/thumb from the detached mirror NOW — decoding the
    // recorded blob for thumbnails while the preview runs blanks it on
    // many Androids.
    const capturedThumbs = this.captureTakeThumbs().catch(() => null)
    try {
      const result = await this.recorder.stop()
      if (!result) {
        this.props.showToast('Hold a bit longer')
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
        await this.props.ensureProjectId(),
        {
          ...result,
          ...(fix ? { lat: fix.lat, lng: fix.lng, locationAccuracyM: fix.accuracyM } : {}),
        },
        { capturedThumbs: await capturedThumbs },
      )
      this.props.refresh()
    } catch (err) {
      reportError(err, 'save-clip')
      this.props.showToast(err instanceof Error ? err.message : 'Save failed')
    } finally {
      this.endInFlight = false
      // stop() resolves only after the blob's duration is measured, so a
      // quick next hold may already be recording by now — never strip the
      // mic, monitor, or wake lock from that newer session.
      if (!this.recorder.isRecording && !this.beginInFlight) {
        this.micMonitor?.stop()
        this.micMonitor = null
        this.camera.releaseMic()
        this.releaseWakeLock()
        this.stopThumbMirror()
      }
    }
  }

  startSelfTimer() {
    if (this.recording || this.props.interactionLocked || this.countdown !== null) return
    if (this.screenSession) return
    if (!this.camera.getStream() || !this.camera.isReady) {
      this.props.showToast('Camera not ready')
      return
    }

    let next = 3
    this.countdown = next
    this.sync()
    const tick = () => {
      next -= 1
      if (next <= 0) {
        this.countdownTimer = 0
        this.countdown = null
        this.sync()
        void (async () => {
          const started = await this.beginRecord(null, 'hands-free')
          if (started) {
            this.props.showToast('Recording hands-free — tap the preview to stop')
          }
        })()
        return
      }
      this.countdown = next
      this.sync()
      this.countdownTimer = window.setTimeout(tick, 1000)
    }
    this.countdownTimer = window.setTimeout(tick, 1000)
  }

  deleteLastClip() {
    const lastClip = this.props.clips.at(-1)
    if (!lastClip) {
      this.props.showToast('No clips yet')
      return
    }
    void (async () => {
      await removeClip(lastClip.id)
      this.props.refresh()
      this.props.showToast('Last clip deleted', {
        actionLabel: 'Undo',
        onAction: () => {
          void (async () => {
            await undoLastDelete(this.props.project.id)
            this.props.refresh()
            this.props.showToast('Clip restored')
          })()
        },
      })
    })()
  }

  toggleLocationTagging() {
    if (this.recording || this.countdown !== null) return
    if (this.locationTagging) {
      void (async () => {
        try {
          await setLocationTaggingEnabled(false)
          this.locationTagging = false
          this.sync()
          this.props.showToast('Location tagging off')
        } catch {
          this.props.showToast('Could not save the setting — try again')
        }
      })()
      return
    }
    // Tap is the user gesture that legitimizes the permission prompt.
    void (async () => {
      const fix = await getLocationFix()
      if (!fix) {
        this.props.showToast("Location unavailable — check the site's location permission")
        return
      }
      try {
        await setLocationTaggingEnabled(true)
        this.locationTagging = true
        this.sync()
        this.props.showToast('Location tagging on — new clips will be geotagged')
      } catch {
        this.props.showToast('Could not save the setting — try again')
      }
    })()
  }

  cleanupOnUnmount() {
    window.clearTimeout(this.countdownTimer)
    this.countdownTimer = 0
    cancelAnimationFrame(this.zoomRestoreRaf)
    cancelAnimationFrame(this.elapsedRaf)
    window.clearTimeout(this.zoomHudTimer)
    this.micMonitor?.stop()
    this.micMonitor = null
    this.recorder.cancel()
    this.stopThumbMirror()
    // Leaving the screen mustn't lose an active screen take — save it.
    void this.finishScreenRecord()
    this.releaseWakeLock()
  }

  /**
   * Release the camera whenever the app leaves the foreground — Android
   * keeps the privacy indicator lit as long as any track is live. An
   * in-progress take is finished and saved first.
   */
  onVisibilityChange = () => {
    const camera = this.camera
    if (document.hidden) {
      this.clearCountdown()
      this.micSilent = false
      this.sync()
      if (this.recorder.isRecording || this.recording) {
        void this.endRecord()
      }
      camera.stop()
      return
    }
    // Coming back to the foreground: restart the camera unconditionally.
    // Screen-off freezes the camera track at the OS level; a surviving
    // stream would keep previewing a single stale frame forever.
    void (async () => {
      if (this.recorder.isRecording || this.recording) {
        await this.endRecord()
      }
      camera.stop()
      if (document.hidden) return
      await camera.start()
      if (document.hidden) camera.stop()
    })()
  }

  // Desktop keyboard support.
  onWindowKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat || this.props.interactionLocked) return
    if (isInteractiveTarget(event)) return
    switch (event.code) {
      case 'Space': {
        event.preventDefault()
        if (this.countdown !== null) {
          this.clearCountdown()
          this.props.showToast('Timer canceled')
          return
        }
        if (this.recording) {
          if (this.recordingMode === 'hands-free') void this.endRecord()
          return
        }
        cancelAnimationFrame(this.zoomRestoreRaf)
        if (this.zoomRestoreActive) {
          this.zoomRestoreActive = false
          this.camera.setZoom(this.zoomBaseline ?? this.camera.zoom?.value ?? 1)
        }
        this.spaceHeld = true
        this.keyboardTake = true
        void this.beginRecord(null, 'hold').then((started) => {
          if (!started) {
            this.keyboardTake = false
            return
          }
          // Space was released while the mic grant was in flight.
          if (!this.spaceHeld) {
            this.keyboardTake = false
            void this.endRecord()
          }
        })
        return
      }
      case 'KeyE': {
        if (this.recording) return
        this.camera.releaseMic()
        this.props.onOpenEditor()
        return
      }
      case 'KeyP': {
        if (!this.recording && this.props.clips.length > 0) this.props.onPlay()
        return
      }
      case 'KeyF': {
        if (!this.recording && this.camera.canFlip && this.countdown === null) {
          void this.camera.flip()
        }
        return
      }
      case 'KeyT': {
        if (!this.recording && this.countdown === null) this.startSelfTimer()
        return
      }
      case 'KeyS': {
        if (this.recording || this.countdown !== null) return
        if (this.screenSession) void this.finishScreenRecord()
        else if (isScreenRecordingSupported()) this.startScreenRecord()
        return
      }
      case 'Backspace':
      case 'Delete': {
        event.preventDefault()
        if (!this.recording && this.props.clips.length > 0) this.deleteLastClip()
        return
      }
      default:
        return
    }
  }

  onWindowKeyUp = (event: KeyboardEvent): void => {
    if (event.code !== 'Space') return
    this.spaceHeld = false
    // Only a keyboard-started hold (no owning pointer) ends on keyup.
    if (this.recording && this.recordingMode === 'hold' && this.pointerId === null) {
      this.keyboardTake = false
      void this.endRecord()
    }
  }

  // ---- stage pointer handlers (hold-to-record + drag-to-zoom) ----

  onStagePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    // While recording the screen, the whole stage is the stop button.
    if (this.screenSession) {
      void this.finishScreenRecord()
      return
    }
    if (this.countdown !== null) {
      this.clearCountdown()
      this.props.showToast('Timer canceled')
      return
    }
    if (this.recording && this.recordingMode === 'hands-free') {
      void this.endRecord()
      return
    }
    // A Space-owned take ends on Space keyup only.
    if (this.keyboardTake) return
    // A second finger landing during an active hold must not reset the
    // drag-zoom state or start another take.
    if (this.pointerId !== null) return
    // A new hold interrupts any snap-back still easing; the take starts
    // from the user's deliberate baseline zoom, not a mid-ramp value.
    cancelAnimationFrame(this.zoomRestoreRaf)
    this.dragZoomMoved = false
    this.dragZoomPressY = event.clientY
    this.dragZoomStartValue = this.zoomBaseline ?? this.camera.zoom?.value ?? 1
    if (this.zoomRestoreActive) {
      this.zoomRestoreActive = false
      this.camera.setZoom(this.dragZoomStartValue)
    }
    const stage = event.currentTarget as HTMLDivElement
    const stageRect = stage.getBoundingClientRect()
    this.dragZoomStageHeight = stageRect.height
    this.dragZoomStageTop = stageRect.top
    stage.setPointerCapture(event.pointerId)
    void this.beginRecord(event.pointerId, 'hold')
  }

  onStagePointerMove = (event: PointerEvent): void => {
    if (this.recordingMode !== 'hold') return
    if (this.pointerId === null || this.pointerId !== event.pointerId) return
    const zoom = this.camera.zoom
    if (!zoom) return
    if (zoom.max - zoom.min <= 0) return
    // Dead zone: natural finger tremble while holding must not start
    // zooming. Once crossed, re-anchor so zoom ramps without a jump.
    if (!this.dragZoomMoved) {
      if (Math.abs(event.clientY - this.dragZoomPressY) < DRAG_ZOOM_DEADZONE_PX) {
        return
      }
      this.dragZoomPressY = event.clientY
    }
    const next = dragZoomValue({
      anchorY: this.dragZoomPressY,
      clientY: event.clientY,
      stageTop: this.dragZoomStageTop,
      stageHeight: this.dragZoomStageHeight || this.els.stage?.clientHeight || 1,
      start: this.dragZoomStartValue,
      min: zoom.min,
      max: zoom.max,
    })
    this.dragZoomMoved = true
    this.dragZoomLastValue = next
    this.camera.setZoom(next)
    this.showZoomHud(next)
  }

  onStagePointerUp = (event: PointerEvent): void => {
    if (this.keyboardTake) return
    if (this.recordingMode !== 'hands-free') {
      // Only the pointer that owns the hold may end the take and start the
      // snap-back — a stray second finger lifting must not zoom out.
      const ownsHold = this.pointerId === null || this.pointerId === event.pointerId
      void this.endRecord(event.pointerId)
      if (ownsHold) this.restoreZoomAfterHold()
    }
  }

  // ---- skeleton + sync ----

  override render(): void {
    const { project, camera, onOpenEditor, onOpenExport, onPlay } = this.props
    this.locationTagging = this.props.locationTaggingEnabled ?? false
    const screenRecordingSupported = isScreenRecordingSupported()

    const els = this.els

    els.video = h('video', { className: 'camera-video', muted: true, autoplay: true })
    els.video.playsInline = true
    els.video.setAttribute('playsinline', 'true')

    els.recordPillLabel = h('span', { className: 'record-pill-label' }, 'REC')
    els.recordElapsed = h('span', { className: 'record-elapsed' })
    els.recordOverlay = h(
      'div',
      { className: 'record-overlay', hidden: true },
      h(
        'div',
        { className: 'record-pill', 'aria-live': 'polite' },
        h('span', { className: 'record-dot' }),
        els.recordPillLabel,
        els.recordElapsed,
      ),
    )

    els.screenElapsed = h('span', { className: 'record-elapsed' })
    els.screenOverlay = h(
      'div',
      { className: 'record-overlay', hidden: true },
      h(
        'div',
        { className: 'record-pill', 'aria-live': 'polite' },
        h('span', { className: 'record-dot' }),
        h('span', { className: 'record-pill-label' }, 'SCREEN — TAP TO STOP'),
        els.screenElapsed,
      ),
    )

    els.countdownNumber = h('span', { className: 'countdown-number' })
    els.countdownOverlay = h(
      'div',
      { className: 'countdown-overlay', 'aria-live': 'assertive', hidden: true },
      els.countdownNumber,
    )

    els.holdHint = h(
      'div',
      { className: 'hold-hint', hidden: true },
      h('strong', null, 'Hold anywhere'),
      h('span', null, 'release to stop'),
    )

    els.zoomHud = h('div', { className: 'zoom-hud', 'aria-hidden': 'true' })

    els.permissionMessage = h('p')
    els.permissionPanel = h(
      'div',
      { className: 'permission-panel', hidden: true },
      h(
        'div',
        null,
        h('h2', null, 'Camera access'),
        els.permissionMessage,
        h(
          'button',
          { type: 'button', className: 'btn btn-primary', onclick: () => void camera.start() },
          'Try again',
        ),
      ),
    )

    els.stage = h(
      'div',
      {
        className: 'record-stage',
        onpointerdown: this.onStagePointerDown,
        onpointermove: this.onStagePointerMove,
        onpointerup: this.onStagePointerUp,
        onpointercancel: this.onStagePointerUp,
        oncontextmenu: (event: Event) => event.preventDefault(),
      },
      els.video,
      els.recordOverlay,
      els.screenOverlay,
      els.countdownOverlay,
      els.holdHint,
      els.zoomHud,
      els.permissionPanel,
    )

    // Top bar
    els.projectName = h('strong', null, project.name)
    els.totalDuration = h('span', { className: 'record-total' })
    els.storagePill = h('a', {
      href: '/',
      className: 'storage-pill',
      hidden: true,
      'aria-label': 'Device storage almost full — manage projects',
    })
    els.micBlockedPill = h(
      'span',
      {
        className: 'storage-pill is-critical',
        role: 'status',
        hidden: true,
        'aria-label': 'Microphone blocked — recordings need sound',
      },
      'Mic blocked — allow it in site settings',
    )
    els.micSilentPill = h(
      'span',
      {
        className: 'storage-pill is-critical',
        role: 'status',
        hidden: true,
        'aria-label': 'Microphone is not picking up sound',
      },
      'Mic isn’t picking up sound',
    )

    els.screenButton = h(
      'button',
      {
        type: 'button',
        className: 'btn-icon',
        hidden: !screenRecordingSupported,
        'aria-label': 'Record your screen',
        onclick: () => {
          if (this.screenSession) void this.finishScreenRecord()
          else this.startScreenRecord()
        },
      },
      iconScreen(22, false),
    )
    els.torchButton = h(
      'button',
      {
        type: 'button',
        className: 'btn-icon',
        hidden: true,
        'aria-label': 'Toggle flash',
        onclick: () => void camera.setTorch(!camera.torchOn),
      },
      iconTorch(22, false),
    )
    els.flipButton = h(
      'button',
      {
        type: 'button',
        className: 'btn-icon',
        'aria-label': 'Flip camera',
        disabled: true,
        onclick: () => {
          // The baseline belongs to the previous lens; the new camera
          // starts from its own default zoom.
          cancelAnimationFrame(this.zoomRestoreRaf)
          this.zoomBaseline = null
          this.dragZoomMoved = false
          void camera.flip()
        },
      },
      iconFlip(),
    )

    els.top = h(
      'div',
      { className: 'record-top' },
      h(
        'a',
        {
          href: '/',
          className: 'btn-icon',
          'aria-label': 'Back to projects',
          onclick: (event: MouseEvent) => {
            // Modifier/middle clicks open a new tab and leave this page
            // mounted — don't tear down the live camera session for them.
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
            if (event.button !== 0) return
            this.cleanupOnUnmount()
          },
        },
        iconBack(),
      ),
      h(
        'div',
        { className: 'record-meta' },
        els.projectName,
        els.totalDuration,
        els.storagePill,
        els.micBlockedPill,
        els.micSilentPill,
      ),
      h('div', { className: 'record-top-actions' }, els.screenButton, els.torchButton, els.flipButton),
    )

    els.zoomRow = h('div', {
      className: 'record-zoom',
      role: 'group',
      'aria-label': 'Zoom and lens',
      hidden: true,
    })

    els.keyHints = h('div', { className: 'key-hints', 'aria-hidden': 'true' })
    els.keyHints.innerHTML =
      'Hold <kbd>Space</kbd> record · <kbd>F</kbd> flip · <kbd>T</kbd> timer · ' +
      (screenRecordingSupported ? '<kbd>S</kbd> screen · ' : '') +
      '<kbd>E</kbd> editor · <kbd>P</kbd> play · <kbd>⌫</kbd> delete last'

    els.editorButton = h(
      'button',
      {
        type: 'button',
        className: 'btn-icon',
        'aria-label': 'Open editor',
        onclick: () => {
          camera.releaseMic()
          onOpenEditor()
        },
      },
      iconEditor(),
    )
    els.timerButton = h(
      'button',
      {
        type: 'button',
        className: 'btn-icon',
        'aria-label': 'Self-timer',
        onclick: () => this.startSelfTimer(),
      },
      iconTimer(),
    )
    els.locationButton = h(
      'button',
      {
        type: 'button',
        className: 'btn-icon',
        'aria-label': 'Toggle location tagging',
        onclick: () => this.toggleLocationTagging(),
      },
      iconLocation(),
    )
    els.playButton = h(
      'button',
      {
        type: 'button',
        className: 'btn-icon',
        'aria-label': 'Play project preview',
        onclick: () => onPlay(),
      },
      iconPlay(),
    )
    els.deleteButton = h(
      'button',
      {
        type: 'button',
        className: 'btn-icon',
        'aria-label': 'Delete last clip',
        onclick: () => this.deleteLastClip(),
      },
      iconDeleteLast(),
    )
    els.goButton = h(
      'button',
      { type: 'button', className: 'go-button', onclick: () => onOpenExport() },
      'Go',
    )

    els.dock = h(
      'div',
      { className: 'record-dock' },
      h(
        'div',
        { className: 'record-tools' },
        els.editorButton,
        els.timerButton,
        els.locationButton,
        els.playButton,
        els.deleteButton,
      ),
      els.goButton,
    )

    els.root = h(
      'div',
      { className: 'record-screen' },
      els.stage,
      els.top,
      els.zoomRow,
      els.keyHints,
      els.dock,
    )
    this.replaceChildren(els.root)

    // Lifecycle: listeners + camera attach. The cleanup listener registers
    // BEFORE camera.attachVideo's own abort listener so an active take is
    // finished/saved before the camera stream is stopped.
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    window.addEventListener('keydown', this.onWindowKeyDown)
    window.addEventListener('keyup', this.onWindowKeyUp)
    this.signal.addEventListener('abort', () => {
      document.removeEventListener('visibilitychange', this.onVisibilityChange)
      window.removeEventListener('keydown', this.onWindowKeyDown)
      window.removeEventListener('keyup', this.onWindowKeyUp)
      this.cleanupOnUnmount()
    })
    camera.attachVideo(els.video, this.signal)

    this.sync()
  }

  /** Imperative state → DOM sync (no rebuilds; safe during recording). */
  sync() {
    const els = this.els
    if (!els.root || !this.isConnected) return
    const { project, clips, storage, camera } = this.props
    const recording = this.recording
    const totalDurationMs = clips.reduce((sum, clip) => sum + effectiveDurationMs(clip), 0)
    const severity = this.storageState()

    els.root.classList.toggle('is-recording', recording)
    els.video.classList.toggle('mirror', camera.facing === 'user')

    // REC pill + elapsed timer (rAF text writer, nothing re-renders).
    els.recordOverlay.hidden = !recording
    els.recordPillLabel.textContent = this.recordingMode === 'hands-free' ? 'TAP TO STOP' : 'REC'
    els.screenOverlay.hidden = !this.screenRecording
    cancelAnimationFrame(this.elapsedRaf)
    if (recording || this.screenRecording) {
      const startedAt = recording ? this.recordStartedAt : this.screenRecordStartedAt
      const target = recording ? els.recordElapsed : els.screenElapsed
      const tick = () => {
        target.textContent = formatDuration(Math.max(0, performance.now() - startedAt))
        this.elapsedRaf = requestAnimationFrame(tick)
      }
      tick()
    }

    els.countdownOverlay.hidden = this.countdown === null
    if (this.countdown !== null) els.countdownNumber.textContent = String(this.countdown)

    els.holdHint.hidden = !(
      !recording &&
      !this.screenRecording &&
      this.countdown === null &&
      camera.isReady
    )
    els.holdHint.classList.toggle('hold-hint-subtle', clips.length > 0)

    const needsPermission =
      camera.permission.status === 'denied' ||
      camera.permission.status === 'unsupported' ||
      (!!camera.error && !camera.isReady)
    els.permissionPanel.hidden = !needsPermission
    if (needsPermission) {
      els.permissionMessage.textContent =
        camera.error ??
        camera.permission.message ??
        'Allow camera to preview. Recording needs the microphone too.'
    }

    els.projectName.textContent = project.name
    els.totalDuration.textContent = formatDuration(totalDurationMs)
    const showStoragePill = storage && severity !== 'ok' && !recording
    els.storagePill.hidden = !showStoragePill
    if (showStoragePill) {
      els.storagePill.classList.toggle('is-critical', severity === 'critical')
      els.storagePill.textContent = `Storage ${formatStoragePercent(storage.ratio)} full`
    }
    els.micBlockedPill.hidden = !(camera.micPermission === 'denied' && !recording)
    els.micSilentPill.hidden = !(this.micSilent && camera.micPermission !== 'denied')

    els.screenButton.classList.toggle('is-active', this.screenRecording)
    els.screenButton.setAttribute('aria-pressed', String(this.screenRecording))
    els.screenButton.setAttribute(
      'aria-label',
      this.screenRecording ? 'Stop screen recording' : 'Record your screen',
    )
    els.screenButton.disabled = recording || this.countdown !== null
    els.screenButton.replaceChildren(iconScreen(22, this.screenRecording))

    els.torchButton.hidden = !camera.torchAvailable
    els.torchButton.classList.toggle('is-active', camera.torchOn)
    els.torchButton.setAttribute('aria-pressed', String(camera.torchOn))
    els.torchButton.disabled = recording || this.countdown !== null
    els.torchButton.replaceChildren(iconTorch(22, camera.torchOn))

    els.flipButton.disabled = !camera.canFlip || recording || this.countdown !== null

    this.syncZoomChips()

    els.editorButton.disabled = recording || this.screenRecording
    els.timerButton.disabled = recording || this.screenRecording || this.countdown !== null
    els.locationButton.disabled = recording || this.countdown !== null
    els.locationButton.classList.toggle('is-active', this.locationTagging)
    els.locationButton.setAttribute('aria-pressed', String(this.locationTagging))
    els.playButton.disabled = recording || this.screenRecording || clips.length === 0
    els.deleteButton.disabled = recording || this.screenRecording || clips.length === 0
    els.goButton.disabled = clips.length === 0 || recording || this.screenRecording
  }

  /** Zoom / lens chips: rebuilt only when their content actually changes. */
  syncZoomChips() {
    const els = this.els
    const camera = this.camera
    const zoomLevels = camera.zoom ? zoomChipLevels(camera.zoom) : []
    const activeZoomLevel =
      camera.zoom && zoomLevels.length > 0 ? nearestZoomLevel(zoomLevels, camera.zoom.value) : null
    // Ultra-wide/telephoto are usually separate rear cameras on Android — a
    // lens chip is the only way to reach 0.5× when zoom can't go below 1×.
    const showLensChip = camera.facing === 'environment' && camera.rearLensCount > 1
    const show = zoomLevels.length > 0 || showLensChip
    els.zoomRow.hidden = !show
    if (!show) {
      this.#chipSignature = null
      return
    }

    const disabled = this.countdown !== null
    const signature = [
      zoomLevels.join(','),
      activeZoomLevel,
      showLensChip ? `${camera.rearLensIndex}/${camera.rearLensCount}` : '',
      this.recording,
      disabled,
      camera.isReady,
    ].join('|')
    if (signature === this.#chipSignature) return
    this.#chipSignature = signature

    const chips = []
    if (showLensChip) {
      chips.push(
        h(
          'button',
          {
            type: 'button',
            className: 'zoom-chip lens-chip',
            'aria-label': `Switch rear lens (${camera.rearLensIndex + 1} of ${camera.rearLensCount})`,
            disabled: this.recording || disabled || !camera.isReady,
            onclick: (event: Event) => {
              event.stopPropagation()
              // Each lens has its own zoom range and default.
              cancelAnimationFrame(this.zoomRestoreRaf)
              this.zoomBaseline = null
              this.dragZoomMoved = false
              void camera
                .switchRearLens()
                .then(() => {
                  const range = camera.getZoom()
                  if (range) this.showZoomHud(range.value)
                })
                .catch(() => undefined)
            },
          },
          iconLens(14),
          `${camera.rearLensIndex + 1}/${camera.rearLensCount}`,
        ),
      )
    }
    for (const level of zoomLevels) {
      const isActive = activeZoomLevel !== null && Math.abs(activeZoomLevel - level) < 0.05
      chips.push(
        h(
          'button',
          {
            type: 'button',
            className: `zoom-chip${isActive ? ' is-active' : ''}`,
            'aria-pressed': String(isActive),
            disabled,
            onclick: (event: Event) => {
              event.stopPropagation()
              cancelAnimationFrame(this.zoomRestoreRaf)
              this.zoomBaseline = level
              camera.setZoom(level)
              this.showZoomHud(level)
            },
          },
          formatZoomLabel(level),
        ),
      )
    }
    els.zoomRow.replaceChildren(...chips)
  }
}
define('kv-record-screen', KvRecordScreen)
