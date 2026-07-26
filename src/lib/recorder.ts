import { pickRecorderMimeType } from './media'

export interface RecordingResult {
  blob: Blob
  mimeType: string
  durationMs: number
}

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

  get isRecording(): boolean {
    return this.recorder?.state === 'recording'
  }

  /** @returns true when a new recording actually started */
  start(stream: MediaStream): boolean {
    if (this.isRecording || this.stopping) return false

    this.mimeType = pickRecorderMimeType()
    this.chunks = []
    this.startedAt = performance.now()

    const recorder = this.mimeType
      ? new MediaRecorder(stream, {
          mimeType: this.mimeType,
          videoBitsPerSecond: 2_500_000,
        })
      : new MediaRecorder(stream)

    this.mimeType = recorder.mimeType || this.mimeType || 'video/webm'
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data)
    }
    this.recorder = recorder
    recorder.start(100)
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
    const durationMs = Math.max(0, Math.round(performance.now() - this.startedAt))

    return new Promise((resolve, reject) => {
      recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mimeType })
        this.recorder = null
        this.chunks = []
        this.stopping = false
        if (blob.size === 0 || durationMs < 120) {
          resolve(null)
          return
        }
        resolve({
          blob,
          mimeType: this.mimeType,
          durationMs,
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
