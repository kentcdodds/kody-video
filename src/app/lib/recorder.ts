import { isMediaElementFailure } from './export/media-error.ts'
import { measureBlobDuration, pickRecordingMimeType } from './media.ts'

export interface RecordingResult {
  blob: Blob
  mimeType: string
  durationMs: number
  width?: number
  height?: number
}

/** Ignore accidental taps shorter than this — they can't produce a real clip. */
const MIN_TAKE_MS = 120

/**
 * Hold-to-record helper around MediaRecorder.
 * Starts on press, stops on release; returns a Blob for IndexedDB storage.
 */
/** One take's private state. Handlers close over their own session, so a
 * stale MediaRecorder event (a canceled take's stop arriving after the next
 * take began) can only ever touch its own clones and chunks. */
interface RecordingSession {
  recorder: MediaRecorder
  /** Recording consumes CLONES of the preview's tracks: MediaRecorder
   * attaching/detaching directly on the live camera track makes some
   * Android HALs reconfigure the capture pipeline, blanking the preview
   * for a frame right when the take ends. Clones detach invisibly. */
  stream: MediaStream
  chunks: BlobPart[]
  mimeType: string
  startedAt: number
  trackWidth: number | undefined
  trackHeight: number | undefined
}

function stopSessionTracks(session: RecordingSession): void {
  session.stream.getTracks().forEach((track) => {
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
    const clones = stream.getTracks().map((track) => track.clone())
    const recordStream = new MediaStream(clones)

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
      // the clones must not outlive the failed attempt.
      recordStream.getTracks().forEach((track) => {
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
    const wallClockMs = Math.max(0, Math.round(performance.now() - session.startedAt))
    const finishSession = () => {
      stopSessionTracks(session)
      if (this.session === session) {
        this.session = null
        this.stopping = false
      }
    }

    return new Promise((resolve, reject) => {
      session.recorder.onstop = () => {
        finishSession()
        const blob = new Blob(session.chunks, { type: session.mimeType })
        const width = session.trackWidth
        const height = session.trackHeight
        if (blob.size === 0 || wallClockMs < MIN_TAKE_MS) {
          resolve(null)
          return
        }
        // The blob's real duration is shorter than wall clock (encoder start
        // latency); trims and export math must use the media duration.
        void measureBlobDuration(blob)
          .then((measuredMs) => {
            resolve({
              blob,
              mimeType: session.mimeType || blob.type || 'video/webm',
              durationMs: measuredMs > 0 ? measuredMs : wallClockMs,
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
              width,
              height,
            })
          })
      }
      session.recorder.onerror = () => {
        finishSession()
        reject(new Error('Recording failed'))
      }
      session.recorder.stop()
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
