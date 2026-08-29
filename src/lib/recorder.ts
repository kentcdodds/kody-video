import { isMediaElementFailure } from './export/media-error'
import { measureBlobDuration, pickRecordingMimeType } from './media'
import {
  canRecordOffThread,
  RecorderWorkerHost,
  RecorderWorkerOpenError,
  reattachReturnedAudio,
  swapAudioForPlaceholders,
} from './recorder-off-thread'
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

/** Bound warm-session memory: recycle the live encoder often enough that
 * discarding a short tap does not have to flush a multi-second 1080p
 * file. The startup hole lands in the discarded pre-roll of the new
 * session. */
const WARM_RECYCLE_MS = 1_500

const RECORD_AUDIO_BITS_PER_SECOND = 192_000

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

/** Blob length when media duration cannot be measured: encoder start →
 * stop (adopted pre-roll + hold + grace). Never shorter than the hold,
 * so a clock inversion cannot hide the take. */
export function takeFallbackDurationMs(
  sessionStartedAt: number,
  stoppedAt: number,
  takeWallMs: number,
): number {
  return Math.max(takeWallMs, Math.round(stoppedAt - sessionStartedAt))
}

/** One take's private state. Handlers close over their own session, so a
 * stale MediaRecorder event (a canceled take's stop arriving after the next
 * take began) can only ever touch its own clones and chunks. */
interface MainRecordingSession {
  kind: 'main'
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

interface OffThreadRecordingSession {
  kind: 'off-thread'
  sessionId: string
  /** Preview/camera stream — still holds audio placeholders while the
   * worker owns the live mic originals. */
  source: MediaStream
  audioPlaceholders: MediaStreamAudioTrack[]
  mimeType: string
  startedAt: number
  takeStartedAt?: number
  trackWidth: number | undefined
  trackHeight: number | undefined
  live: boolean
}

type RecordingSession = MainRecordingSession | OffThreadRecordingSession

function stopMainSessionTracks(session: MainRecordingSession): void {
  session.clonedTracks.forEach((track) => {
    track.stop()
  })
}

function sessionHasLiveAudio(session: RecordingSession): boolean {
  if (session.kind === 'off-thread') {
    return (
      session.audioPlaceholders.some((track) => track.readyState === 'live') ||
      session.source.getAudioTracks().some((track) => track.readyState === 'live')
    )
  }
  return session.stream.getAudioTracks().some((track) => track.readyState === 'live')
}

function markVideoMotionHint(track: MediaStreamTrack): void {
  if ('contentHint' in track) track.contentHint = 'motion'
}

/**
 * Hold-to-record helper around MediaRecorder.
 * Starts on press, stops on release; returns a Blob for IndexedDB storage.
 *
 * When the browser can transfer tracks into a dedicated worker, the live
 * encoder and its `ondataavailable` loop run there so mid-take main-thread
 * work cannot starve chunk delivery. Browsers that cannot do that keep
 * today's in-page MediaRecorder.
 */
export class HoldRecorder {
  private session: RecordingSession | null = null
  /** Live encoder running before the press so the take can adopt it. */
  private warm: RecordingSession | null = null
  private warming = false
  private dummyRecorder: MediaRecorder | null = null
  private dummyClones: MediaStreamTrack[] = []
  private stopping = false
  private recycleTimer = 0
  /** Preview stream the current warm/dummy encoder was built from.
   * Camera swaps mint a new MediaStream; clones from the previous one
   * keep the old camera open (Android exclusive HAL / privacy dot). */
  private warmSource: MediaStream | null = null
  private warmSourceEnded: (() => void) | null = null
  /** Cuts a pending stop grace short — set only while a stop() is waiting
   * out its grace window (see cancel()). */
  private fireStopNow: (() => void) | null = null
  private workerHost: RecorderWorkerHost | null = null
  private starting = false
  /** Serializes arm/start/stop/disarm so a worker cancel can return the
   * mic originals before the next session swaps placeholders again. */
  private chain: Promise<void> = Promise.resolve()

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work)
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private warmSessionIsReusable(stream: MediaStream): boolean {
    if (this.warmSource !== stream || !this.warm) return false
    if (!sessionHasLiveAudio(this.warm)) return false
    if (this.warm.kind === 'off-thread') return this.warm.live
    if (this.warm.recorder.state !== 'recording') return false
    return this.warm.clonedTracks.every((track) => track.readyState === 'live')
  }

  private unbindWarmSource(): void {
    const stream = this.warmSource
    const onEnded = this.warmSourceEnded
    this.warmSource = null
    this.warmSourceEnded = null
    const video = stream?.getVideoTracks()[0]
    if (video && onEnded) video.removeEventListener('ended', onEnded)
  }

  private bindWarmSource(stream: MediaStream): void {
    this.unbindWarmSource()
    this.warmSource = stream
    const video = stream.getVideoTracks()[0]
    if (!video) return
    // Preview track.stop() (flip / lens / tab hide) must drop clones in
    // the same turn the camera HAL is released — otherwise Android cannot
    // open the next exclusive rear lens.
    const onEnded = () => {
      if (this.warmSource !== stream) return
      this.disarm()
    }
    this.warmSourceEnded = onEnded
    video.addEventListener('ended', onEnded)
  }

  get isRecording(): boolean {
    const session = this.session
    if (!session) return false
    if (session.kind === 'off-thread') return session.live
    return session.recorder.state === 'recording'
  }

  /** Which encoder the current warm or live session is using. */
  get captureThread(): 'worker' | 'main' | 'idle' {
    const session = this.session ?? this.warm
    if (!session) return 'idle'
    return session.kind === 'off-thread' ? 'worker' : 'main'
  }

  /** Spin a live encoder on this stream so the next start() can adopt it
   * (startup hole stays in discarded pre-roll). Requires a live audio
   * track — MediaRecorder cannot add the mic later. No-ops while a take
   * is running or a warm session is already live on a compatible stream. */
  arm(stream: MediaStream): void {
    if (this.isRecording || this.stopping) return
    void this.enqueue(async () => {
      if (this.isRecording || this.stopping) return
      if (this.warmSessionIsReusable(stream)) return
      if (!stream.getAudioTracks().some((track) => track.readyState === 'live')) {
        await this.disarmNow()
        this.startDummyWarmup(stream)
        return
      }
      await this.disarmNow()
      const created = await this.createSession(stream)
      if (!created) return
      this.warm = created
      this.bindWarmSource(stream)
      this.recycleTimer = window.setTimeout(() => {
        this.recycleTimer = 0
        if (this.session || this.stopping) return
        void this.enqueue(async () => {
          if (this.session || this.stopping) return
          await this.disarmNow()
          this.arm(stream)
        })
      }, WARM_RECYCLE_MS)
    })
  }

  /** Video-only dummy start/stop to initialize the hardware encoder when
   * the mic is not yet live (first Android take). Best-effort: a later
   * real MediaRecorder may still pay startup, which is why arm() is
   * preferred once audio is available. */
  warmUp(stream: MediaStream): void {
    void this.enqueue(async () => {
      if (this.isRecording || this.stopping) return
      if (this.warmSessionIsReusable(stream)) return
      if (this.warming && this.warmSource === stream) return
      await this.disarmNow()
      this.startDummyWarmup(stream)
    })
  }

  private startDummyWarmup(stream: MediaStream): void {
    const video = stream.getVideoTracks()[0]
    if (!video || video.readyState !== 'live') return
    this.stopDummy()
    const clone = video.clone()
    markVideoMotionHint(clone)
    const warmStream = new MediaStream([clone])
    try {
      const settings = video.getSettings()
      const recorder = this.makeRecorder(warmStream, settings.width, settings.height)
      this.warming = true
      this.dummyRecorder = recorder
      this.dummyClones = [clone]
      this.bindWarmSource(stream)
      recorder.ondataavailable = () => undefined
      recorder.onstop = () => {
        this.finishDummy(recorder)
      }
      recorder.onerror = () => {
        this.finishDummy(recorder)
      }
      recorder.start()
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
      this.unbindWarmSource()
    }
  }

  /** Drop a warm/dummy encoder without saving. Safe during camera stop. */
  disarm(): void {
    void this.enqueue(async () => {
      await this.disarmNow()
    })
  }

  private async disarmNow(): Promise<void> {
    this.stopDummy()
    window.clearTimeout(this.recycleTimer)
    this.recycleTimer = 0
    const warm = this.warm
    this.warm = null
    this.unbindWarmSource()
    if (!warm) return
    await this.teardownSession(warm)
  }

  /** @returns true when a new recording actually started */
  start(stream: MediaStream): Promise<boolean> {
    if (this.isRecording || this.stopping || this.starting) return Promise.resolve(false)
    const pressAt = performance.now()
    this.starting = true
    return this.enqueue(async () => {
      try {
        if (this.isRecording || this.stopping) return false

        if (this.warmSessionIsReusable(stream)) {
          const adopted = this.warm
          if (!adopted) return false
          this.warm = null
          this.unbindWarmSource()
          window.clearTimeout(this.recycleTimer)
          this.recycleTimer = 0
          this.stopDummy()
          // Always stamp the press. A young session may still contain the
          // startup hole, but take length must be press→release — otherwise a
          // 40ms tap on a 200ms-old warm session looks like a 240ms take and
          // is saved. Stamp the wall-clock from BEFORE the queue wait so a
          // pending arm() does not inflate the take.
          adopted.takeStartedAt = pressAt
          this.session = adopted
          return true
        }

        await this.disarmNow()
        const created = await this.createSession(stream)
        if (!created) return false
        this.session = created
        return true
      } finally {
        this.starting = false
      }
    })
  }

  /** `graceMs: 0` skips the stop-grace tail. The encoder flush itself is
   * awaited (a worker MediaRecorder cannot stop in the same turn as the
   * call) — callers that will tear the camera down must await this. */
  stop(options?: { graceMs?: number }): Promise<RecordingResult | null> {
    const session = this.session
    if (!session || !this.sessionIsRecording(session)) {
      if (session) void this.teardownSession(session)
      this.session = null
      this.stopping = false
      return Promise.resolve(null)
    }

    this.stopping = true
    const releaseAt = performance.now()
    const takeStartedAt = session.takeStartedAt ?? session.startedAt
    const takeWallMs = Math.max(0, Math.round(releaseAt - takeStartedAt))

    return this.enqueue(async () => {
      /** How long the recorder actually kept running past the release —
       * the timer can fire late under load, and the trim-back must walk
       * back by the REAL overshoot or it would eat kept content. */
      const graceMs = takeWallMs < MIN_TAKE_MS ? 0 : (options?.graceMs ?? STOP_GRACE_MS)
      const graceActualMs = await this.waitStopGrace(releaseAt, graceMs)
      let blob: Blob
      let mimeType: string
      try {
        const finished = await this.finishRecording(session)
        blob = finished.blob
        mimeType = finished.mimeType
      } catch {
        if (this.session === session) {
          this.session = null
          this.stopping = false
        }
        throw new Error('Recording failed')
      }
      if (this.session === session) {
        this.session = null
        this.stopping = false
      }
      const width = session.trackWidth
      const height = session.trackHeight
      if (blob.size === 0 || takeWallMs < MIN_TAKE_MS) return null
      const fallbackMs = takeFallbackDurationMs(session.startedAt, performance.now(), takeWallMs)
      try {
        const measuredMs = await measureBlobDuration(blob)
        const durationMs = measuredMs > 0 ? measuredMs : fallbackMs
        const trimEndMs = takeTrimEndMs(durationMs, graceActualMs)
        return {
          blob,
          mimeType: mimeType || blob.type || 'video/webm',
          durationMs,
          trimStartMs: takeTrimStartMs(trimEndMs, takeWallMs),
          trimEndMs,
          width,
          height,
        }
      } catch (error) {
        // A media-element failure means the browser cannot decode this
        // take at all — keeping it would only fail again at export.
        // Timeouts still fall back to session wall-clock (streamy WebM)
        // so adopted pre-roll stays outside the kept range.
        if (isMediaElementFailure(error)) return null
        const trimEndMs = takeTrimEndMs(fallbackMs, graceActualMs)
        return {
          blob,
          mimeType: mimeType || blob.type || 'video/webm',
          durationMs: fallbackMs,
          trimStartMs: takeTrimStartMs(trimEndMs, takeWallMs),
          trimEndMs,
          width,
          height,
        }
      }
    })
  }

  cancel(): void {
    // Hasten an in-flight grace immediately — cancel is often called from
    // unmount and must not wait for the queue to reach the stop() work.
    this.fireStopNow?.()
    void this.enqueue(async () => {
      await this.disarmNow()
      // A stop() already owns this session (waiting out its grace, or
      // awaiting onstop): let its save resolve. Discarding here would
      // orphan the pending stop() promise — endRecord would hang and a
      // take the user properly released would be lost.
      if (this.stopping) return
      const session = this.session
      this.session = null
      this.stopping = false
      if (session) await this.teardownSession(session)
      this.workerHost?.terminate()
      this.workerHost = null
    })
  }

  private sessionIsRecording(session: RecordingSession): boolean {
    if (session.kind === 'off-thread') return session.live
    return session.recorder.state === 'recording'
  }

  private waitStopGrace(releaseAt: number, graceMs: number): Promise<number> {
    if (graceMs <= 0) return Promise.resolve(0)
    return new Promise((resolve) => {
      let graceTimer = 0
      const fire = () => {
        window.clearTimeout(graceTimer)
        this.fireStopNow = null
        resolve(Math.round(performance.now() - releaseAt))
      }
      this.fireStopNow = fire
      graceTimer = window.setTimeout(fire, graceMs)
    })
  }

  private async finishRecording(
    session: RecordingSession,
  ): Promise<{ blob: Blob; mimeType: string }> {
    if (session.kind === 'off-thread') {
      session.live = false
      const host = this.ensureWorkerHost()
      const stopped = await host.stop(session.sessionId)
      reattachReturnedAudio(session.source, session.audioPlaceholders, stopped.audioTracks)
      return { blob: stopped.blob, mimeType: stopped.mimeType }
    }
    const blob = await this.stopMainRecorder(session)
    return { blob, mimeType: session.mimeType || blob.type || 'video/webm' }
  }

  private stopMainRecorder(session: MainRecordingSession): Promise<Blob> {
    return new Promise((resolve, reject) => {
      session.recorder.onstop = () => {
        stopMainSessionTracks(session)
        resolve(new Blob(session.chunks, { type: session.mimeType }))
      }
      session.recorder.onerror = () => {
        stopMainSessionTracks(session)
        reject(new Error('Recording failed'))
      }
      if (session.recorder.state !== 'inactive') {
        try {
          session.recorder.stop()
          return
        } catch {
          // Fall through.
        }
      }
      stopMainSessionTracks(session)
      resolve(new Blob(session.chunks, { type: session.mimeType }))
    })
  }

  private async teardownSession(session: RecordingSession): Promise<void> {
    if (session.kind === 'off-thread') {
      session.live = false
      if (!this.workerHost) return
      try {
        const canceled = await this.workerHost.cancel(session.sessionId)
        reattachReturnedAudio(session.source, session.audioPlaceholders, canceled.audioTracks)
      } catch {
        // Worker died — placeholders still carry the mic on the camera stream.
      }
      return
    }
    session.recorder.ondataavailable = null
    session.recorder.onstop = () => stopMainSessionTracks(session)
    session.recorder.onerror = () => stopMainSessionTracks(session)
    if (session.recorder.state !== 'inactive') {
      try {
        session.recorder.stop()
        return
      } catch {
        // Fall through — stop the clones directly.
      }
    }
    stopMainSessionTracks(session)
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
          audioBitsPerSecond: RECORD_AUDIO_BITS_PER_SECOND,
        })
      : new MediaRecorder(recordStream)
  }

  private async createSession(stream: MediaStream): Promise<RecordingSession | null> {
    if (canRecordOffThread()) {
      const off = await this.createOffThreadSession(stream)
      if (off) return off
    }
    return this.createMainThreadSession(stream)
  }

  private async createOffThreadSession(
    stream: MediaStream,
  ): Promise<OffThreadRecordingSession | null> {
    const host = this.ensureWorkerHost()
    if (!(await host.isUsable())) return null

    const settings = stream.getVideoTracks()[0]?.getSettings()
    const videoClones = stream.getVideoTracks().map((track) => {
      const clone = track.clone()
      markVideoMotionHint(clone)
      return clone
    })
    const { originals, placeholders } = swapAudioForPlaceholders(stream)
    try {
      const opened = await host.open([...videoClones, ...originals], {
        mimeType: pickRecordingMimeType(),
        videoBitsPerSecond: recordingVideoBitsPerSecond(settings?.width, settings?.height),
        audioBitsPerSecond: RECORD_AUDIO_BITS_PER_SECOND,
      })
      const session: OffThreadRecordingSession = {
        kind: 'off-thread',
        sessionId: opened.sessionId,
        source: stream,
        audioPlaceholders: placeholders,
        mimeType: opened.mimeType,
        startedAt: performance.now(),
        trackWidth: settings?.width,
        trackHeight: settings?.height,
        live: true,
      }
      placeholders.forEach((placeholder) => {
        placeholder.addEventListener(
          'ended',
          () => {
            if (this.warm === session) this.disarm()
          },
          { once: true },
        )
      })
      return session
    } catch (error) {
      const returned = error instanceof RecorderWorkerOpenError ? error.tracks : []
      const returnedAudio = returned.filter((track) => track.kind === 'audio')
      const returnedVideo = returned.filter((track) => track.kind === 'video')
      reattachReturnedAudio(
        stream,
        placeholders,
        returnedAudio.length > 0 ? returnedAudio : originals,
      )
      returnedVideo.forEach((track) => {
        track.stop()
      })
      videoClones.forEach((track) => {
        try {
          track.stop()
        } catch {
          // Transferred into the worker (and already stopped there).
        }
      })
      return null
    }
  }

  private createMainThreadSession(stream: MediaStream): MainRecordingSession | null {
    const settings = stream.getVideoTracks()[0]?.getSettings()
    const clones = stream.getVideoTracks().map((track) => {
      const clone = track.clone()
      markVideoMotionHint(clone)
      return clone
    })
    const recordStream = new MediaStream([...clones, ...stream.getAudioTracks()])

    try {
      const recorder = this.makeRecorder(recordStream, settings?.width, settings?.height)
      const preferredMime = pickRecordingMimeType()
      const session: MainRecordingSession = {
        kind: 'main',
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
      // No timeslice: mid-take Blob events on the main thread compete with
      // the preview. Short clips (and 1.5s warm sessions) fit in memory;
      // data arrives once, on stop.
      recorder.start()
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

  private ensureWorkerHost(): RecorderWorkerHost {
    if (this.workerHost) return this.workerHost
    const host = new RecorderWorkerHost()
    host.onTrackEnded = (sessionId) => {
      const warm = this.warm
      if (warm?.kind === 'off-thread' && warm.sessionId === sessionId) {
        this.disarm()
      }
    }
    this.workerHost = host
    return host
  }
}
