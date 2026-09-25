import { VIDEO_FPS } from './video-quality'

/**
 * Latest-wins zoom writer for one camera track. Drag-to-zoom fires a
 * pointermove per touch sample (60–120/s) and the snap-back ramp one per
 * animation frame, and every write is an applyConstraints round trip into
 * the camera stack (a Camera2 repeating-request swap on Android, a device
 * configuration lock on iOS). Unthrottled, one drag queued more camera
 * reconfigurations than the camera produces frames — mid-take.
 *
 * At most one write is in flight, and writes start at least one camera
 * frame apart; values set in between collapse into the latest one, which
 * always lands.
 */
export interface ZoomWriter {
  set(value: number): void
  /** Drop pending writes (the track is going away). */
  dispose(): void
}

export interface ZoomWriterOptions {
  minIntervalMs?: number
  now?: () => number
  schedule?: (run: () => void, delayMs: number) => number
  cancel?: (handle: number) => void
}

export function createZoomWriter(
  apply: (value: number) => Promise<unknown>,
  options: ZoomWriterOptions = {},
): ZoomWriter {
  const minIntervalMs = options.minIntervalMs ?? 1000 / VIDEO_FPS
  const now = options.now ?? (() => performance.now())
  const schedule = options.schedule ?? ((run, delayMs) => window.setTimeout(run, delayMs))
  const cancel = options.cancel ?? ((handle) => window.clearTimeout(handle))

  let pending: number | null = null
  let lastWritten: number | null = null
  let inFlight = false
  let lastStartedAt = Number.NEGATIVE_INFINITY
  let timer = 0
  let disposed = false

  const pump = (): void => {
    if (disposed || inFlight || timer || pending === null) return
    if (pending === lastWritten) {
      pending = null
      return
    }
    const waitMs = lastStartedAt + minIntervalMs - now()
    if (waitMs > 0) {
      timer = schedule(() => {
        timer = 0
        pump()
      }, waitMs)
      return
    }
    const value = pending
    pending = null
    lastWritten = value
    lastStartedAt = now()
    inFlight = true
    let write: Promise<unknown>
    try {
      write = Promise.resolve(apply(value))
    } catch (error) {
      write = Promise.reject(error)
    }
    void write
      .catch(() => undefined)
      .finally(() => {
        inFlight = false
        pump()
      })
  }

  return {
    set(value) {
      if (disposed) return
      pending = value
      pump()
    },
    dispose() {
      disposed = true
      pending = null
      if (timer) cancel(timer)
      timer = 0
    },
  }
}
