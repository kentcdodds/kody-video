/**
 * Service-worker update helpers. Registration comes from `registerSW` in
 * app.tsx; this module owns apply + resume probes so any screen can trigger
 * a check, and so the app can re-check when the user returns.
 *
 * Applying an update is not "skipWaiting + location.reload()". A reload
 * that races the new worker (or that iOS standalone recycles in-place)
 * keeps serving the old precache — the toast comes back, About still shows
 * the old SHA, and only killing the PWA actually boots the new build.
 * Apply waits for `controllerchange`, then force-navigates; if the new
 * worker never claims, it drops the worker + Cache Storage (never
 * IndexedDB) and reloads from the network, same idea as /api/recover.
 */

import { COMMIT_SHA } from './build-info'

let registration: ServiceWorkerRegistration | null = null
let applyUpdate: ((reloadPage?: boolean) => Promise<void>) | null = null
let notifyNeedRefresh: (() => void) | null = null

/** Minimum gap between quiet resume probes (visibility/focus/pageshow burst). */
const DEFAULT_RESUME_MIN_INTERVAL_MS = 30_000
const DEFAULT_CLAIM_TIMEOUT_MS = 2_500
const DEPLOYED_CACHE_MS = 10_000
const FETCH_TIMEOUT_MS = 4_000
const DIAG_KEY = 'kody:update-diag'
const DIAG_MAX_EVENTS = 12
/** Query mark so iOS standalone cannot recycle the in-memory document. */
export const UPDATE_NAV_PARAM = '_sw'

let resumeChecksAttached = false
let lastQuietProbeAt = 0
let quietProbeInFlight = false
let resumeMinIntervalMs = DEFAULT_RESUME_MIN_INTERVAL_MS
let claimTimeoutMs = DEFAULT_CLAIM_TIMEOUT_MS
let deployedInFlight: Promise<DeployedVersion | null> | null = null
let deployedCache: { at: number; value: DeployedVersion | null } | null = null

type UpdateTestHooks = {
  navigate?: (url: string) => void
  fetchDeployed?: () => Promise<DeployedVersion | null>
  purge?: () => Promise<void>
  runningSha?: string
}

let testHooks: UpdateTestHooks = {}

export type DeployedVersion = { commit: string }

export type UpdateDiagEvent = {
  at: number
  phase: string
  reason?: string
  claimed?: boolean
  running?: string
  deployed?: string | null
  waiting?: boolean
  installing?: boolean
  hasController?: boolean
}

export function registerUpdateHandles(
  reg: ServiceWorkerRegistration | null | undefined,
  apply: (reloadPage?: boolean) => Promise<void>,
  notifyRefresh?: () => void,
): void {
  registration = reg ?? null
  applyUpdate = apply
  notifyNeedRefresh = notifyRefresh ?? null
  // The initial registerSW({ immediate: true }) already probed once —
  // don't fire again from the first focus/pageshow burst after load.
  lastQuietProbeAt = Date.now()
  attachResumeUpdateChecks()
  // registerSW({ immediate: true }) already called registration.update().
  // Still compare /version.json on boot: a failed apply can leave this
  // tab on a retired bundle while the worker looks "current".
  void fetchDeployedVersion().then((deployed) => {
    if (isRunningStale(deployed)) notifyNeedRefresh?.()
  })
}

export type UpdateCheckResult = 'updated' | 'current' | 'downloading' | 'unavailable'

/**
 * Ask the service worker for a new version right now. When one is found it
 * is applied immediately (the page navigates into the new version) — the user
 * explicitly asked, so no extra confirmation step. A slow install that
 * outlives the wait reports 'downloading'; the standard update toast offers
 * it when it finishes.
 *
 * If the worker reports "already current" but this JS bundle's commit does
 * not match /version.json, the shell is stale and we force a clean reload.
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const reg = registration
  if (!reg) return 'unavailable'
  const deployedPromise = fetchDeployedVersion()
  try {
    await reg.update()
  } catch {
    if (reg.waiting || reg.installing) {
      return activateWaitingWorker({ reason: 'manual-offline-waiting' })
    }
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
  if (workerAppeared) {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      if (reg.waiting) return activateWaitingWorker({ reason: 'manual-waiting' })
      if (!reg.installing) {
        // A worker appeared but is neither installing nor waiting anymore:
        // the install failed (worker went redundant). Don't claim "current".
        return 'unavailable'
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    if (reg.waiting) return activateWaitingWorker({ reason: 'manual-waiting' })
    if (reg.installing) return 'downloading'
  }

  const deployed = await deployedPromise
  if (isRunningStale(deployed)) {
    return activateWaitingWorker({ reason: 'manual-stale-shell', forcePurge: true })
  }
  return 'current'
}

/**
 * Quietly ask the service worker whether a newer version exists. Does not
 * apply the update — when one is found, vite-plugin-pwa's `onNeedRefresh`
 * shows the existing toast so the user can choose when to reload.
 * A /version.json mismatch also raises the toast: the worker can look
 * "current" while this tab is still running a retired bundle.
 */
export function probeForUpdates(): void {
  const reg = registration
  if (!reg || quietProbeInFlight) return
  quietProbeInFlight = true
  lastQuietProbeAt = Date.now()
  void Promise.all([
    reg.update().catch(() => undefined),
    fetchDeployedVersion()
      .then((deployed) => {
        if (isRunningStale(deployed)) notifyNeedRefresh?.()
      })
      .catch(() => undefined),
  ]).finally(() => {
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

/** User tapped Update on the toast (or About already decided to apply). */
export async function applyWaitingUpdate(): Promise<UpdateCheckResult> {
  return activateWaitingWorker({ reason: 'toast' })
}

async function activateWaitingWorker(options: {
  reason: string
  forcePurge?: boolean
}): Promise<UpdateCheckResult> {
  const reg = registration
  const waiting = reg?.waiting ?? null
  const installing = reg?.installing ?? null
  const worker = waiting ?? installing
  // Do not block SKIP_WAITING on /version.json — a hung probe used to
  // leave the toast looking dead. Claim first; the stamp is only needed
  // to decide whether a no-worker tap should purge.
  const deployedPromise = fetchDeployedVersion()

  recordDiag({
    phase: 'apply-start',
    reason: options.reason,
    running: testHooks.runningSha ?? COMMIT_SHA,
    waiting: Boolean(waiting),
    installing: Boolean(installing),
    hasController: Boolean(navigator.serviceWorker?.controller),
  })

  // Best-effort: tell workbox-window too. It no-ops when its own
  // registration.waiting is stale; we still postMessage on `worker` below.
  if (applyUpdate && worker) {
    void Promise.resolve(applyUpdate(true)).catch(() => undefined)
  }

  if (worker && !options.forcePurge) {
    const claimed = await skipWaitingAndAwaitClaim(worker)
    recordDiag({
      phase: 'claim',
      reason: options.reason,
      claimed,
      waiting: Boolean(reg?.waiting),
      installing: Boolean(reg?.installing),
      hasController: Boolean(navigator.serviceWorker?.controller),
    })
    if (claimed) {
      hardNavigate()
      return 'updated'
    }
  }

  const deployed = await deployedPromise
  if (!worker && !options.forcePurge && !isRunningStale(deployed)) {
    recordDiag({
      phase: 'no-worker',
      reason: options.reason,
      deployed: deployed?.commit ?? null,
    })
    return 'unavailable'
  }

  try {
    if (testHooks.purge) await testHooks.purge()
    else await purgeWorkersAndCaches()
  } catch {
    recordDiag({ phase: 'purge-failed', reason: options.reason })
    return 'unavailable'
  }
  recordDiag({ phase: 'purged-reload', reason: options.reason })
  hardNavigate()
  return 'updated'
}

function skipWaitingAndAwaitClaim(worker: ServiceWorker): Promise<boolean> {
  return new Promise((resolve) => {
    const serviceWorker = navigator.serviceWorker
    if (!serviceWorker) {
      resolve(false)
      return
    }
    if (serviceWorker.controller === worker) {
      resolve(true)
      return
    }
    let settled = false
    const finish = (claimed: boolean) => {
      if (settled) return
      settled = true
      serviceWorker.removeEventListener('controllerchange', onChange)
      window.clearTimeout(timer)
      resolve(claimed)
    }
    const onChange = () => finish(true)
    const timer = window.setTimeout(() => finish(false), claimTimeoutMs)
    serviceWorker.addEventListener('controllerchange', onChange)
    try {
      worker.postMessage({ type: 'SKIP_WAITING' })
    } catch {
      finish(false)
    }
  })
}

async function purgeWorkersAndCaches(): Promise<void> {
  const regs = await (navigator.serviceWorker?.getRegistrations?.() ?? [])
  await Promise.all(regs.map((reg) => reg.unregister()))
  const keys = await (self.caches?.keys?.() ?? [])
  await Promise.all(keys.map((key) => caches.delete(key)))
  const urls = new Set([location.pathname || '/', '/'])
  await Promise.allSettled(
    [...urls].map((url) =>
      fetchWithTimeout(url, { cache: 'reload', credentials: 'same-origin' }, FETCH_TIMEOUT_MS),
    ),
  )
}

function hardNavigate(): void {
  const url = new URL(location.href)
  url.searchParams.delete(UPDATE_NAV_PARAM)
  url.searchParams.set(UPDATE_NAV_PARAM, String(Date.now()))
  const next = `${url.pathname}${url.search}${url.hash}`
  if (testHooks.navigate) {
    testHooks.navigate(next)
    return
  }
  location.replace(next)
}

/** Drop the one-shot navigation mark so the address bar / router stay clean. */
export function stripUpdateNavigationMark(): void {
  if (typeof location === 'undefined' || typeof history === 'undefined') return
  const url = new URL(location.href)
  if (!url.searchParams.has(UPDATE_NAV_PARAM)) return
  url.searchParams.delete(UPDATE_NAV_PARAM)
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

export function isRunningStale(deployed: DeployedVersion | null | undefined): boolean {
  if (!deployed) return false
  const running = testHooks.runningSha ?? COMMIT_SHA
  if (running === 'dev') return false
  return deployed.commit !== running
}

export function fetchDeployedVersion(): Promise<DeployedVersion | null> {
  if (testHooks.fetchDeployed) return testHooks.fetchDeployed()
  if (deployedCache && Date.now() - deployedCache.at < DEPLOYED_CACHE_MS) {
    return Promise.resolve(deployedCache.value)
  }
  if (deployedInFlight) return deployedInFlight
  const request = (async () => {
    try {
      const res = await fetchWithTimeout(
        '/version.json',
        { cache: 'no-store', headers: { accept: 'application/json' } },
        FETCH_TIMEOUT_MS,
      )
      if (!res.ok) return null
      const data = (await res.json()) as { commit?: unknown }
      if (typeof data.commit !== 'string' || data.commit.length === 0) return null
      const value = { commit: data.commit }
      deployedCache = { at: Date.now(), value }
      return value
    } catch {
      return null
    }
  })()
  deployedInFlight = request
  void request.finally(() => {
    if (deployedInFlight === request) deployedInFlight = null
  })
  return request
}

/** setTimeout-based so a hung fetch cannot stall apply on older WebKit. */
function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`Timed out fetching ${url}`)), ms)
    void fetch(url, init).then(
      (res) => {
        window.clearTimeout(timer)
        resolve(res)
      },
      (err: unknown) => {
        window.clearTimeout(timer)
        reject(err)
      },
    )
  })
}

function recordDiag(event: Omit<UpdateDiagEvent, 'at'>): void {
  const next: UpdateDiagEvent = { at: Date.now(), ...event }
  try {
    const prev = readDiagEvents()
    prev.push(next)
    sessionStorage.setItem(DIAG_KEY, JSON.stringify(prev.slice(-DIAG_MAX_EVENTS)))
  } catch {
    // private mode / blocked storage
  }
}

function readDiagEvents(): UpdateDiagEvent[] {
  try {
    const raw = sessionStorage.getItem(DIAG_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isDiagEvent)
  } catch {
    return []
  }
}

function isDiagEvent(value: unknown): value is UpdateDiagEvent {
  if (value == null || typeof value !== 'object') return false
  const event = value as UpdateDiagEvent
  return typeof event.at === 'number' && typeof event.phase === 'string'
}

/** Last apply attempts + worker snapshot, for the About diagnostics panel. */
export function getUpdateDiagnostics(): {
  events: UpdateDiagEvent[]
  waiting: boolean
  installing: boolean
  hasController: boolean
} {
  return {
    events: readDiagEvents(),
    waiting: Boolean(registration?.waiting),
    installing: Boolean(registration?.installing),
    hasController: Boolean(
      typeof navigator !== 'undefined' && navigator.serviceWorker?.controller,
    ),
  }
}

/** Test-only: reset module listeners/state between Vitest cases. */
export function resetAppUpdateForTests(options?: {
  minIntervalMs?: number
  claimTimeoutMs?: number
  navigate?: (url: string) => void
  fetchDeployed?: () => Promise<DeployedVersion | null>
  purge?: () => Promise<void>
  runningSha?: string
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
  notifyNeedRefresh = null
  resumeChecksAttached = false
  lastQuietProbeAt = 0
  quietProbeInFlight = false
  resumeMinIntervalMs = options?.minIntervalMs ?? DEFAULT_RESUME_MIN_INTERVAL_MS
  claimTimeoutMs = options?.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS
  deployedInFlight = null
  deployedCache = null
  testHooks = {
    navigate: options?.navigate,
    fetchDeployed: options?.fetchDeployed,
    purge: options?.purge,
    runningSha: options?.runningSha,
  }
  try {
    sessionStorage.removeItem(DIAG_KEY)
  } catch {
    // ignore
  }
}
