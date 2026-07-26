import { measureBlobDuration, pickRecordingMimeType } from './media'

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
export class HoldRecorder {
  private recorder: MediaRecorder | null = null
  private chunks: BlobPart[] = []
  private startedAt = 0
  private mimeType = ''
  private stopping = false
  private trackWidth: number | undefined
  private trackHeight: number | undefined

  get isRecording(): boolean {
    return this.recorder?.state === 'recording'
  }

  /** @returns true when a new recording actually started */
  start(stream: MediaStream): boolean {
    if (this.isRecording || this.stopping) return false

    this.mimeType = pickRecordingMimeType()
    this.chunks = []
    this.startedAt = performance.now()

    const settings = stream.getVideoTracks()[0]?.getSettings()
    this.trackWidth = settings?.width
    this.trackHeight = settings?.height

    const recorder = this.mimeType
      ? new MediaRecorder(stream, {
          mimeType: this.mimeType,
          videoBitsPerSecond: 3_500_000,
          audioBitsPerSecond: 128_000,
        })
      : new MediaRecorder(stream)

    this.mimeType = recorder.mimeType || this.mimeType || 'video/webm'
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data)
    }
    this.recorder = recorder
    recorder.start(250)
    return true
  }

  stop(): Promise<RecordingResult | null> {
    const recorder = this.recorder
    if (!recorder || recorder.state === 'inactive') {
      this.recorder = null
      this.stopping = false
      return Promise.resolve(null)
    }

    this.stopping = true
    const wallClockMs = Math.max(0, Math.round(performance.now() - this.startedAt))

    return new Promise((resolve, reject) => {
      recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mimeType })
        const width = this.trackWidth
        const height = this.trackHeight
        this.recorder = null
        this.chunks = []
        this.stopping = false
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
              mimeType: this.mimeType || blob.type || 'video/webm',
              durationMs: measuredMs > 0 ? measuredMs : wallClockMs,
              width,
              height,
            })
          })
          .catch(() => {
            resolve({
              blob,
              mimeType: this.mimeType || blob.type || 'video/webm',
              durationMs: wallClockMs,
              width,
              height,
            })
          })
      }
      recorder.onerror = () => {
        this.recorder = null
        this.stopping = false
        reject(new Error('Recording failed'))
      }
      recorder.stop()
    })
  }

  cancel(): void {
    const recorder = this.recorder
    if (!recorder) {
      this.stopping = false
      return
    }
    recorder.ondataavailable = null
    if (recorder.state !== 'inactive') {
      try {
        recorder.stop()
      } catch {
        // ignore
      }
    }
    this.recorder = null
    this.chunks = []
    this.stopping = false
  }
}
