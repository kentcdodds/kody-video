import { isMediaElementFailure } from './export/media-error'
import { measureBlobDuration, pickRecordingMimeType } from './media'

export interface RecordingResult {
  blob: Blob
  mimeType: string
  durationMs: number
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

/** Release point on the media timeline: the media ends ~graceMs after the
 * release, so walk back from the measured end — never under the minimum
 * take length (the planner drops sub-50ms segments; a sliver of a trim
 * range helps nobody). */
export function takeTrimEndMs(measuredMs: number, graceMs: number): number {
  return Math.min(measuredMs, Math.max(MIN_TAKE_MS, measuredMs - graceMs))
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
  trackWidth: number | undefined
  trackHeight: number | undefined
}

function stopSessionTracks(session: RecordingSession): void {
  session.clonedTracks.forEach((track) => {
    track.stop()
  })
}

export class HoldRecorder {
  private session: RecordingSession | null = null
  private stopping = false

  get isRecording(): boolean {
    return this.session?.recorder.state === 'recording'
  }

  /** @returns true when a new recording actually started */
  start(stream: MediaStream): boolean {
    if (this.isRecording || this.stopping) return false

    const settings = stream.getVideoTracks()[0]?.getSettings()
    const clones = stream.getVideoTracks().map((track) => track.clone())
    const recordStream = new MediaStream([...clones, ...stream.getAudioTracks()])

    let recorder: MediaRecorder
    try {
      const preferredMime = pickRecordingMimeType()
      recorder = preferredMime
        ? new MediaRecorder(recordStream, {
            mimeType: preferredMime,
            videoBitsPerSecond: 3_500_000,
            audioBitsPerSecond: 192_000,
          })
        : new MediaRecorder(recordStream)

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
      this.session = session
      return true
    } catch {
      // Constructor/start can throw (unsupported params, dead tracks) —
      // the clones must not outlive the failed attempt. (Never the audio
      // track: that is the camera's live mic.)
      clones.forEach((track) => {
        track.stop()
      })
      return false
    }
  }

  stop(): Promise<RecordingResult | null> {
    const session = this.session
    if (!session || session.recorder.state === 'inactive') {
      if (session) stopSessionTracks(session)
      this.session = null
      this.stopping = false
      return Promise.resolve(null)
    }

    this.stopping = true
    const releaseAt = performance.now()
    const wallClockMs = Math.max(0, Math.round(releaseAt - session.startedAt))
    const finishSession = () => {
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
        if (blob.size === 0 || wallClockMs < MIN_TAKE_MS) {
          resolve(null)
          return
        }
        // The blob's real duration differs from wall clock (encoder start
        // latency, stop grace); trims and export math must use the media
        // duration.
        void measureBlobDuration(blob)
          .then((measuredMs) => {
            resolve({
              blob,
              mimeType: session.mimeType || blob.type || 'video/webm',
              durationMs: measuredMs > 0 ? measuredMs : wallClockMs,
              trimEndMs:
                measuredMs > 0 ? takeTrimEndMs(measuredMs, graceActualMs) : wallClockMs,
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
              durationMs: wallClockMs,
              trimEndMs: wallClockMs,
              width,
              height,
            })
          })
      }
      session.recorder.onerror = () => {
        finishSession()
        reject(new Error('Recording failed'))
      }
      window.setTimeout(() => {
        graceActualMs = Math.round(performance.now() - releaseAt)
        // cancel() may have raced the grace timer and already stopped it.
        if (session.recorder.state !== 'inactive') {
          session.recorder.stop()
        }
      }, STOP_GRACE_MS)
    })
  }

  cancel(): void {
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
}
