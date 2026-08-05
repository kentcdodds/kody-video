/**
 * Service-worker update helpers. Registration + apply come from
 * `registerSW` in app.tsx; this module holds them so any screen can
 * trigger a check, and so the app can re-check when the user returns.
 */

let registration: ServiceWorkerRegistration | null = null
let applyUpdate: ((reloadPage?: boolean) => Promise<void>) | null = null

/** Minimum gap between quiet resume probes (visibility/focus/pageshow burst). */
const DEFAULT_RESUME_MIN_INTERVAL_MS = 30_000

let resumeChecksAttached = false
let lastQuietProbeAt = 0
let quietProbeInFlight = false
let resumeMinIntervalMs = DEFAULT_RESUME_MIN_INTERVAL_MS

export function registerUpdateHandles(
  reg: ServiceWorkerRegistration | null | undefined,
  apply: (reloadPage?: boolean) => Promise<void>,
): void {
  registration = reg ?? null
  applyUpdate = apply
  // The initial registerSW({ immediate: true }) already probed once —
  // don't fire again from the first focus/pageshow burst after load.
  lastQuietProbeAt = Date.now()
  attachResumeUpdateChecks()
}

export type UpdateCheckResult = 'updated' | 'current' | 'downloading' | 'unavailable'

/**
 * Ask the service worker for a new version right now. When one is found it
 * is applied immediately (the page reloads into the new version) — the user
 * explicitly asked, so no extra confirmation step. A slow install that
 * outlives the wait reports 'downloading'; the standard update toast offers
 * it when it finishes.
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const reg = registration
  const apply = applyUpdate
  if (!reg || !apply) return 'unavailable'
  try {
    await reg.update()
  } catch {
    // Offline or the update request failed — report the truth: no update.
    return 'unavailable'
  }
  // update() can resolve before a found worker shows up on `installing` —
  // give the updatefound event a grace window before concluding "current".
  const workerAppeared =
    Boolean(reg.installing || reg.waiting) ||
    (await new Promise<boolean>((resolve) => {
      const onFound = () => {
        cleanup()
        resolve(true)
      }
      const timer = setTimeout(() => {
        cleanup()
        resolve(false)
      }, 1500)
      const cleanup = () => {
        reg.removeEventListener('updatefound', onFound)
        clearTimeout(timer)
      }
      reg.addEventListener('updatefound', onFound)
    }))
  if (!workerAppeared) return 'current'

  // Follow the install through to `waiting`, then apply.
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (reg.waiting) return applyAndReload(apply)
    if (!reg.installing) {
      // A worker appeared but is neither installing nor waiting anymore:
      // the install failed (worker went redundant). Don't claim "current".
      if (!reg.waiting) return 'unavailable'
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  if (reg.waiting) return applyAndReload(apply)
  if (reg.installing) return 'downloading'
  return 'current'
}

/**
 * Quietly ask the service worker whether a newer version exists. Does not
 * apply the update — when one is found, vite-plugin-pwa's `onNeedRefresh`
 * shows the existing toast so the user can choose when to reload.
 */
export function probeForUpdates(): void {
  const reg = registration
  if (!reg || quietProbeInFlight) return
  quietProbeInFlight = true
  lastQuietProbeAt = Date.now()
  void reg
    .update()
    .catch(() => undefined)
    .finally(() => {
      quietProbeInFlight = false
    })
}

function shouldProbeOnResume(): boolean {
  if (!registration) return false
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    return false
  }
  return Date.now() - lastQuietProbeAt >= resumeMinIntervalMs
}

function onAppResume(): void {
  if (!shouldProbeOnResume()) return
  probeForUpdates()
}

function onVisibilityChange(): void {
  if (document.visibilityState !== 'visible') return
  onAppResume()
}

function attachResumeUpdateChecks(): void {
  if (resumeChecksAttached) return
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  resumeChecksAttached = true
  document.addEventListener('visibilitychange', onVisibilityChange)
  // iOS Safari sometimes skips visibilitychange on PWA resume — focus and
  // pageshow cover that long-standing gap (same pattern as the camera).
  window.addEventListener('focus', onAppResume)
  window.addEventListener('pageshow', onAppResume)
}

async function applyAndReload(
  apply: (reloadPage?: boolean) => Promise<void>,
): Promise<UpdateCheckResult> {
  try {
    await apply(true)
  } catch {
    return 'unavailable'
  }
  // Normally clientsClaim + controllerchange reload the page before this
  // fires; service workers deployed before clientsClaim never emit
  // controllerchange, which left the button looking dead. The new worker
  // has been told to activate either way — reload under it.
  window.setTimeout(() => {
    window.location.reload()
  }, 1500)
  return 'updated'
}

/** Test-only: reset module listeners/state between Vitest cases. */
export function resetAppUpdateForTests(options?: {
  minIntervalMs?: number
}): void {
  if (resumeChecksAttached && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
  if (resumeChecksAttached && typeof window !== 'undefined') {
    window.removeEventListener('focus', onAppResume)
    window.removeEventListener('pageshow', onAppResume)
  }
  registration = null
  applyUpdate = null
  resumeChecksAttached = false
  lastQuietProbeAt = 0
  quietProbeInFlight = false
  resumeMinIntervalMs = options?.minIntervalMs ?? DEFAULT_RESUME_MIN_INTERVAL_MS
}
