import { isMediaElementFailure } from './export/media-error'
import { measureBlobDuration, pickRecordingMimeType } from './media'
import { recordingVideoBitsPerSecond } from './video-quality'

export interface RecordingResult {
  blob: Blob
  mimeType: string
  durationMs: number
  /** Default trim-in: adopted warm sessions include pre-roll so the
   * encoder-startup hole sits before the press, not in the kept range. */
  trimStartMs: number
  /** Default trim-out at the RELEASE point: the media runs STOP_GRACE_MS
   * longer (see below), but the clip the user meant ends where they let go. */
  trimEndMs: number
  width?: number
  height?: number
}

/** Ignore accidental taps shorter than this — they can't produce a real clip. */
const MIN_TAKE_MS = 120

/** Keep capturing briefly after release: platform audio encoders drop
 * their final buffered samples at stop (iOS AAC loses ~100ms), which left
 * every clip's tail silent — one half of the audible gap at every clip
 * joint. The grace pushes that loss past the release point; the clip's
 * default trim ends AT the release, so the kept range has sound all the
 * way to its end (and the extra tail becomes trim-handle material). */
const STOP_GRACE_MS = 200

/** How long a video-only dummy encoder runs to initialize the hardware
 * codec before the first take that cannot yet adopt a live session. */
const WARMUP_MS = 400

/** Bound warm-session memory: recycle the live encoder every few seconds
 * while idle so a long sit on the record screen does not accumulate a
 * multi-minute MP4 in RAM. The startup hole lands in the discarded
 * pre-roll of the new session. */
const WARM_RECYCLE_MS = 8_000

/** Release point on the media timeline: the media ends ~graceMs after the
 * release, so walk back from the measured end — never under the minimum
 * take length (the planner drops sub-50ms segments; a sliver of a trim
 * range helps nobody). */
export function takeTrimEndMs(measuredMs: number, graceMs: number): number {
  return Math.min(measuredMs, Math.max(MIN_TAKE_MS, measuredMs - graceMs))
}

/** Default trim-in for a take that adopted a warm encoder: the kept range
 * is the wall-clock hold, ending at trimEnd. Cold starts (no pre-roll)
 * yield 0. */
export function takeTrimStartMs(trimEndMs: number, takeWallMs: number): number {
  if (takeWallMs <= 0) return 0
  return Math.max(0, trimEndMs - takeWallMs)
}

/**
 * Hold-to-record helper around MediaRecorder.
 * Starts on press, stops on release; returns a Blob for IndexedDB storage.
 */
/** One take's private state. Handlers close over their own session, so a
 * stale MediaRecorder event (a canceled take's stop arriving after the next
 * take began) can only ever touch its own clones and chunks. */
interface RecordingSession {
  recorder: MediaRecorder
  /** Recording consumes a CLONE of the preview's VIDEO track: MediaRecorder
   * attaching/detaching directly on the live camera track makes some
   * Android HALs reconfigure the capture pipeline, blanking the preview
   * for a frame right when the take ends. Clones detach invisibly.
   * The AUDIO track is the live mic itself, NOT a clone: a fresh audio
   * clone has to attach to the capture graph at take start, which delivered
   * silence for the first few hundred ms of every clip (the other half of
   * the audible gap at every clip joint). The mic's lifecycle belongs to
   * the camera (enableMic/releaseMic), so the session must never stop it. */
  stream: MediaStream
  /** The tracks this session cloned and therefore owns and stops. */
  clonedTracks: MediaStreamTrack[]
  chunks: BlobPart[]
  mimeType: string
  startedAt: number
  /** Wall-clock press time when this warm session was adopted as a take.
   * Absent on a cold start (press === recorder start). */
  takeStartedAt?: number
  trackWidth: number | undefined
  trackHeight: number | undefined
}

function stopSessionTracks(session: RecordingSession): void {
  session.clonedTracks.forEach((track) => {
    track.stop()
  })
}

function sessionHasLiveAudio(session: RecordingSession): boolean {
  return session.stream.getAudioTracks().some((track) => track.readyState === 'live')
}

export class HoldRecorder {
  private session: RecordingSession | null = null
  /** Live encoder running before the press so the take can adopt it. */
  private warm: RecordingSession | null = null
  private warming = false
  private dummyRecorder: MediaRecorder | null = null
  private dummyClones: MediaStreamTrack[] = []
  private stopping = false
  private recycleTimer = 0
  /** Cuts a pending stop grace short — set only while a stop() is waiting
   * out its grace window (see cancel()). */
  private fireStopNow: (() => void) | null = null

  get isRecording(): boolean {
    return this.session?.recorder.state === 'recording'
  }

  /** Spin a live encoder on this stream so the next start() can adopt it
   * (startup hole stays in discarded pre-roll). Requires a live audio
   * track — MediaRecorder cannot add the mic later. No-ops while a take
   * is running or a warm session is already live on a compatible stream. */
  arm(stream: MediaStream): void {
    if (this.isRecording || this.stopping) return
    if (this.warm?.recorder.state === 'recording' && sessionHasLiveAudio(this.warm)) {
      const videoLive = this.warm.clonedTracks.every((track) => track.readyState === 'live')
      if (videoLive) return
    }
    if (!stream.getAudioTracks().some((track) => track.readyState === 'live')) {
      this.warmUp(stream)
      return
    }
    this.disarm()
    const created = this.createSession(stream)
    if (!created) return
    this.warm = created
    this.recycleTimer = window.setTimeout(() => {
      this.recycleTimer = 0
      if (this.session || this.stopping) return
      this.disarm()
      this.arm(stream)
    }, WARM_RECYCLE_MS)
  }

  /** Video-only dummy start/stop to initialize the hardware encoder when
   * the mic is not yet live (first Android take). Best-effort: a later
   * real MediaRecorder may still pay startup, which is why arm() is
   * preferred once audio is available. */
  warmUp(stream: MediaStream): void {
    if (this.isRecording || this.stopping || this.warming) return
    if (this.warm?.recorder.state === 'recording') return
    const video = stream.getVideoTracks()[0]
    if (!video || video.readyState !== 'live') return
    this.stopDummy()
    const clone = video.clone()
    const warmStream = new MediaStream([clone])
    try {
      const settings = video.getSettings()
      const recorder = this.makeRecorder(warmStream, settings.width, settings.height)
      this.warming = true
      this.dummyRecorder = recorder
      this.dummyClones = [clone]
      recorder.ondataavailable = () => undefined
      recorder.onstop = () => {
        this.finishDummy(recorder)
      }
      recorder.onerror = () => {
        this.finishDummy(recorder)
      }
      recorder.start(250)
      window.setTimeout(() => {
        if (this.dummyRecorder === recorder && recorder.state !== 'inactive') {
          try {
            recorder.stop()
          } catch {
            this.finishDummy(recorder)
          }
        }
      }, WARMUP_MS)
    } catch {
      clone.stop()
      this.warming = false
      this.dummyRecorder = null
      this.dummyClones = []
    }
  }

  /** Drop a warm/dummy encoder without saving. Safe during camera stop. */
  disarm(): void {
    this.stopDummy()
    window.clearTimeout(this.recycleTimer)
    this.recycleTimer = 0
    const warm = this.warm
    this.warm = null
    if (!warm) return
    warm.recorder.ondataavailable = null
    warm.recorder.onstop = () => stopSessionTracks(warm)
    warm.recorder.onerror = () => stopSessionTracks(warm)
    if (warm.recorder.state !== 'inactive') {
      try {
        warm.recorder.stop()
        return
      } catch {
        // Fall through — stop the clones directly.
      }
    }
    stopSessionTracks(warm)
  }

  /** @returns true when a new recording actually started */
  start(stream: MediaStream): boolean {
    if (this.isRecording || this.stopping) return false

    if (this.warm?.recorder.state === 'recording' && sessionHasLiveAudio(this.warm)) {
      const adopted = this.warm
      this.warm = null
      window.clearTimeout(this.recycleTimer)
      this.recycleTimer = 0
      this.stopDummy()
      // Only count pre-roll once the encoder-startup hole is behind us.
      // A just-created session is a cold take (takeStartedAt unset).
      if (performance.now() - adopted.startedAt >= WARMUP_MS) {
        adopted.takeStartedAt = performance.now()
      }
      this.session = adopted
      return true
    }

    this.disarm()
    const created = this.createSession(stream)
    if (!created) return false
    this.session = created
    return true
  }

  /** `graceMs: 0` stops the MediaRecorder SYNCHRONOUSLY inside this call —
   * background/unmount teardown stops the camera right after, and the
   * encoder must have flushed by then. */
  stop(options?: { graceMs?: number }): Promise<RecordingResult | null> {
    const session = this.session
    if (!session || session.recorder.state === 'inactive') {
      if (session) stopSessionTracks(session)
      this.session = null
      this.stopping = false
      return Promise.resolve(null)
    }

    this.stopping = true
    const releaseAt = performance.now()
    const takeStartedAt = session.takeStartedAt ?? session.startedAt
    const takeWallMs = Math.max(0, Math.round(releaseAt - takeStartedAt))
    const finishSession = () => {
      this.fireStopNow = null
      stopSessionTracks(session)
      if (this.session === session) {
        this.session = null
        this.stopping = false
      }
    }

    return new Promise((resolve, reject) => {
      /** How long the recorder actually kept running past the release —
       * the timer can fire late under load, and the trim-back must walk
       * back by the REAL overshoot or it would eat kept content. */
      let graceActualMs = 0
      session.recorder.onstop = () => {
        finishSession()
        const blob = new Blob(session.chunks, { type: session.mimeType })
        const width = session.trackWidth
        const height = session.trackHeight
        if (blob.size === 0 || takeWallMs < MIN_TAKE_MS) {
          resolve(null)
          return
        }
        // The blob's real duration differs from wall clock (encoder start
        // latency, stop grace, adopted pre-roll); trims and export math
        // must use the media duration.
        void measureBlobDuration(blob)
          .then((measuredMs) => {
            const durationMs = measuredMs > 0 ? measuredMs : takeWallMs
            const trimEndMs =
              measuredMs > 0 ? takeTrimEndMs(measuredMs, graceActualMs) : takeWallMs
            resolve({
              blob,
              mimeType: session.mimeType || blob.type || 'video/webm',
              durationMs,
              trimStartMs: takeTrimStartMs(trimEndMs, takeWallMs),
              trimEndMs,
              width,
              height,
            })
          })
          .catch((error) => {
            // A media-element failure means the browser cannot decode this
            // take at all — keeping it would only fail again at export.
            // Timeouts still fall back to wall-clock (streamy WebM).
            if (isMediaElementFailure(error)) {
              resolve(null)
              return
            }
            resolve({
              blob,
              mimeType: session.mimeType || blob.type || 'video/webm',
              durationMs: takeWallMs,
              trimStartMs: 0,
              trimEndMs: takeWallMs,
              width,
              height,
            })
          })
      }
      session.recorder.onerror = () => {
        finishSession()
        reject(new Error('Recording failed'))
      }
      const graceMs = options?.graceMs ?? STOP_GRACE_MS
      let graceTimer = 0
      const fire = () => {
        window.clearTimeout(graceTimer)
        this.fireStopNow = null
        graceActualMs = Math.round(performance.now() - releaseAt)
        if (session.recorder.state !== 'inactive') {
          session.recorder.stop()
        }
      }
      if (graceMs <= 0) {
        fire()
      } else {
        this.fireStopNow = fire
        graceTimer = window.setTimeout(fire, graceMs)
      }
    })
  }

  cancel(): void {
    this.disarm()
    // A stop() already owns this session (waiting out its grace, or
    // awaiting onstop): hasten it and let its save resolve. Discarding
    // here would orphan the pending stop() promise — endRecord would hang
    // and a take the user properly released would be lost.
    if (this.stopping) {
      this.fireStopNow?.()
      return
    }
    const session = this.session
    this.session = null
    this.stopping = false
    if (!session) return
    // Stale events from this session must only clean up after themselves.
    session.recorder.ondataavailable = null
    session.recorder.onstop = () => stopSessionTracks(session)
    session.recorder.onerror = () => stopSessionTracks(session)
    if (session.recorder.state !== 'inactive') {
      try {
        session.recorder.stop()
        return
      } catch {
        // Fall through — stop the clones directly.
      }
    }
    stopSessionTracks(session)
  }

  private finishDummy(recorder: MediaRecorder): void {
    if (this.dummyRecorder === recorder) {
      this.dummyClones.forEach((track) => {
        track.stop()
      })
      this.dummyRecorder = null
      this.dummyClones = []
      this.warming = false
    }
  }

  private stopDummy(): void {
    const recorder = this.dummyRecorder
    const clones = this.dummyClones
    this.dummyRecorder = null
    this.dummyClones = []
    this.warming = false
    if (!recorder) return
    recorder.ondataavailable = null
    recorder.onstop = () => {
      clones.forEach((track) => {
        track.stop()
      })
    }
    recorder.onerror = () => {
      clones.forEach((track) => {
        track.stop()
      })
    }
    if (recorder.state !== 'inactive') {
      try {
        recorder.stop()
        return
      } catch {
        // Fall through.
      }
    }
    clones.forEach((track) => {
      track.stop()
    })
  }

  private makeRecorder(
    recordStream: MediaStream,
    width: number | undefined,
    height: number | undefined,
  ): MediaRecorder {
    const preferredMime = pickRecordingMimeType()
    const videoBitsPerSecond = recordingVideoBitsPerSecond(width, height)
    return preferredMime
      ? new MediaRecorder(recordStream, {
          mimeType: preferredMime,
          videoBitsPerSecond,
          audioBitsPerSecond: 192_000,
        })
      : new MediaRecorder(recordStream)
  }

  private createSession(stream: MediaStream): RecordingSession | null {
    const settings = stream.getVideoTracks()[0]?.getSettings()
    const clones = stream.getVideoTracks().map((track) => track.clone())
    const recordStream = new MediaStream([...clones, ...stream.getAudioTracks()])

    try {
      const recorder = this.makeRecorder(recordStream, settings?.width, settings?.height)
      const preferredMime = pickRecordingMimeType()
      const session: RecordingSession = {
        recorder,
        stream: recordStream,
        clonedTracks: clones,
        chunks: [],
        mimeType: recorder.mimeType || preferredMime || 'video/webm',
        startedAt: performance.now(),
        trackWidth: settings?.width,
        trackHeight: settings?.height,
      }
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) session.chunks.push(event.data)
      }
      recorder.start(250)
      return session
    } catch {
      // Constructor/start can throw (unsupported params, dead tracks) —
      // the clones must not outlive the failed attempt. (Never the audio
      // track: that is the camera's live mic.)
      clones.forEach((track) => {
        track.stop()
      })
      return null
    }
  }
}
