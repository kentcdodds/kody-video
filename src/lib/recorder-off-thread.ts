import {
  isRecorderWorkerResponse,
  type RecorderWorkerRequest,
  type RecorderWorkerResponse,
} from './recorder-worker-protocol'

/**
 * Off-main-thread MediaRecorder host. Transfers video clones + the live
 * mic originals into a dedicated worker so encoded chunks never land on
 * the page's event loop during a take.
 *
 * The camera stream keeps audio *placeholders* (clones of the mic):
 * cloning the mic into MediaRecorder at press time used to deliver a
 * silent head on every clip, so the worker must own the original. The
 * placeholders keep the preview/mic-monitor graph intact and tell us
 * when the camera released the mic (their `ended` event). On stop we
 * transfer the originals back so `releaseMic` still turns the indicator
 * off.
 */

let capabilityCache: boolean | null = null
let enabledOverride: boolean | null = null

/** Test-only: force the worker path on/off, or `null` to use the probe. */
export function setRecorderOffThreadEnabledForTests(value: boolean | null): void {
  enabledOverride = value
}

/** Test-only: drop the capability cache so a stubbed Worker is re-probed. */
export function resetRecorderOffThreadForTests(): void {
  capabilityCache = null
  enabledOverride = null
}

/**
 * True when this browser can transfer MediaStreamTracks into a dedicated
 * worker that exposes MediaRecorder. Canvas-only probe — never touches
 * the live camera.
 */
export function canRecordOffThread(): boolean {
  if (enabledOverride !== null) return enabledOverride
  if (capabilityCache !== null) return capabilityCache
  capabilityCache = probeOffThreadRecording()
  return capabilityCache
}

function probeOffThreadRecording(): boolean {
  if (typeof Worker === 'undefined') return false
  if (typeof MediaRecorder === 'undefined') return false
  if (typeof MediaStreamTrack !== 'function') return false
  if (typeof document === 'undefined' || typeof structuredClone !== 'function') {
    return false
  }
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const stream = canvas.captureStream(0)
    const track = stream.getVideoTracks()[0]
    if (!track) return false
    const clone = track.clone()
    structuredClone(clone, { transfer: [clone] })
    track.stop()
    return true
  } catch {
    return false
  }
}

function liveAudioTracks(tracks: MediaStreamTrack[]): MediaStreamAudioTrack[] {
  return tracks.filter((track): track is MediaStreamAudioTrack => {
    return track.kind === 'audio' && track.readyState === 'live'
  })
}

export function reattachReturnedAudio(
  stream: MediaStream,
  placeholders: MediaStreamAudioTrack[],
  returned: MediaStreamTrack[],
): void {
  const live = liveAudioTracks(returned)
  if (live.length === 0) return
  for (const placeholder of placeholders) {
    if (stream.getAudioTracks().includes(placeholder)) stream.removeTrack(placeholder)
    placeholder.stop()
  }
  for (const track of live) {
    if (!stream.getAudioTracks().includes(track)) stream.addTrack(track)
  }
}

export function swapAudioForPlaceholders(stream: MediaStream): {
  originals: MediaStreamAudioTrack[]
  placeholders: MediaStreamAudioTrack[]
} {
  const originals = stream.getAudioTracks().filter((track) => track.readyState === 'live')
  const placeholders: MediaStreamAudioTrack[] = []
  for (const original of originals) {
    const placeholder = original.clone()
    if (placeholder.kind !== 'audio') continue
    placeholders.push(placeholder)
    stream.removeTrack(original)
    stream.addTrack(placeholder)
  }
  return { originals, placeholders }
}

export interface OffThreadOpenOptions {
  mimeType: string
  videoBitsPerSecond: number
  audioBitsPerSecond: number
}

export interface OffThreadOpened {
  sessionId: string
  mimeType: string
}

export interface OffThreadStopped {
  blob: Blob
  mimeType: string
  audioTracks: MediaStreamTrack[]
}

export interface OffThreadCanceled {
  audioTracks: MediaStreamTrack[]
}

type Pending = {
  resolve: (value: RecorderWorkerResponse) => void
  reject: (error: Error) => void
}

/** Open is usually instant; stop may flush a long hands-free take. */
const WORKER_REQUEST_TIMEOUT_MS = 8_000

export class RecorderWorkerHost {
  private worker: Worker | null = null
  private nextRequestId = 1
  private nextSessionId = 1
  private readonly pending = new Map<number, Pending>()
  private pingResult: boolean | null = null
  onTrackEnded: ((sessionId: string) => void) | null = null

  async isUsable(): Promise<boolean> {
    if (!canRecordOffThread()) return false
    if (this.pingResult !== null) return this.pingResult
    try {
      const response = await this.request({ type: 'ping', requestId: 0 })
      this.pingResult = response.type === 'pong' && response.mediaRecorder
      if (!this.pingResult) this.terminate()
      return this.pingResult
    } catch {
      this.pingResult = false
      this.terminate()
      return false
    }
  }

  async open(tracks: MediaStreamTrack[], options: OffThreadOpenOptions): Promise<OffThreadOpened> {
    const sessionId = `rec-${this.nextSessionId++}`
    const response = await this.request(
      {
        type: 'open',
        requestId: 0,
        sessionId,
        mimeType: options.mimeType,
        videoBitsPerSecond: options.videoBitsPerSecond,
        audioBitsPerSecond: options.audioBitsPerSecond,
        tracks,
      },
      tracks,
    )
    if (response.type === 'opened') {
      return { sessionId: response.sessionId, mimeType: response.mimeType }
    }
    if (response.type === 'error') {
      throw new RecorderWorkerOpenError(response.message, response.tracks)
    }
    throw new Error('Unexpected recorder worker reply')
  }

  async stop(sessionId: string): Promise<OffThreadStopped> {
    const response = await this.request({ type: 'stop', requestId: 0, sessionId })
    if (response.type === 'stopped') {
      return {
        blob: response.blob,
        mimeType: response.mimeType,
        audioTracks: response.audioTracks,
      }
    }
    if (response.type === 'error') {
      throw new Error(response.message)
    }
    throw new Error('Unexpected recorder worker reply')
  }

  async cancel(sessionId: string): Promise<OffThreadCanceled> {
    const response = await this.request({ type: 'cancel', requestId: 0, sessionId })
    if (response.type === 'canceled') {
      return { audioTracks: response.audioTracks }
    }
    if (response.type === 'error') {
      return { audioTracks: response.tracks }
    }
    throw new Error('Unexpected recorder worker reply')
  }

  terminate(): void {
    const worker = this.worker
    this.worker = null
    this.pingResult = null
    this.pending.forEach((pending) => {
      pending.reject(new Error('Recorder worker terminated'))
    })
    this.pending.clear()
    worker?.terminate()
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('./recorder-worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (!isRecorderWorkerResponse(event.data)) return
      const response = event.data
      if (response.type === 'track-ended') {
        this.onTrackEnded?.(response.sessionId)
        return
      }
      const pending = this.pending.get(response.requestId)
      if (!pending) return
      this.pending.delete(response.requestId)
      pending.resolve(response)
    }
    worker.onerror = () => {
      this.pending.forEach((pending) => {
        pending.reject(new Error('Recorder worker failed'))
      })
      this.pending.clear()
      this.terminate()
    }
    this.worker = worker
    return worker
  }

  private request(
    message: RecorderWorkerRequest,
    transfer: Transferable[] = [],
  ): Promise<RecorderWorkerResponse> {
    const worker = this.ensureWorker()
    const requestId = this.nextRequestId++
    const payload = { ...message, requestId }
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('Recorder worker timed out'))
      }, WORKER_REQUEST_TIMEOUT_MS)
      this.pending.set(requestId, {
        resolve: (value) => {
          window.clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          window.clearTimeout(timer)
          reject(error)
        },
      })
      try {
        worker.postMessage(payload, transfer)
      } catch (error) {
        this.pending.delete(requestId)
        window.clearTimeout(timer)
        reject(error instanceof Error ? error : new Error('Could not talk to recorder worker'))
      }
    })
  }
}

export class RecorderWorkerOpenError extends Error {
  readonly tracks: MediaStreamTrack[]

  constructor(message: string, tracks: MediaStreamTrack[]) {
    super(message)
    this.name = 'RecorderWorkerOpenError'
    this.tracks = tracks
  }
}
