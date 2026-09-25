/**
 * Capture-first scheduling. Chromium's MediaRecorder drops recorded frames
 * once the main thread stalls for roughly 200ms (measured with
 * scripts/probe-capture-cadence.mjs), so optional main-thread work — clip
 * hydration, take analysis — waits while a take is live instead of
 * competing with it. Saving the previous take is NOT optional and never
 * waits here.
 */

let activeTakes = 0
let idleWaiters: Array<() => void> = []
/** Optional work currently running, by label — take reports note overlaps. */
const backgroundWork = new Map<string, number>()

/** Mark a take (camera or screen) as recording until the returned release
 * runs. Release is idempotent. */
export function beginCaptureActivity(): () => void {
  activeTakes += 1
  let released = false
  return () => {
    if (released) return
    released = true
    activeTakes = Math.max(0, activeTakes - 1)
    if (activeTakes > 0) return
    const waiters = idleWaiters
    idleWaiters = []
    for (const resolve of waiters) resolve()
  }
}

export function isCaptureActive(): boolean {
  return activeTakes > 0
}

/** Resolves immediately when nothing is recording, otherwise when the last
 * live take releases. Call before each unit of optional work, not once per
 * batch, so a take that starts mid-batch pauses the rest of it. */
export function whenCaptureIdle(): Promise<void> {
  if (activeTakes === 0) return Promise.resolve()
  return new Promise((resolve) => {
    idleWaiters.push(resolve)
  })
}

/** Run one unit of optional work after capture is idle, registered under
 * `label` while it runs. */
export async function runWhenCaptureIdle<T>(label: string, work: () => Promise<T>): Promise<T> {
  await whenCaptureIdle()
  backgroundWork.set(label, (backgroundWork.get(label) ?? 0) + 1)
  try {
    return await work()
  } finally {
    const remaining = (backgroundWork.get(label) ?? 1) - 1
    if (remaining > 0) backgroundWork.set(label, remaining)
    else backgroundWork.delete(label)
  }
}

/** Labels of optional work running right now (for take reports). */
export function activeBackgroundWork(): string[] {
  return [...backgroundWork.keys()]
}

export function resetCaptureActivityForTests(): void {
  activeTakes = 0
  const waiters = idleWaiters
  idleWaiters = []
  for (const resolve of waiters) resolve()
  backgroundWork.clear()
}
