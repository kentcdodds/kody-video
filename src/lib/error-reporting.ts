import { COMMIT_SHA } from './build-info'

/** Publishable client key for the kody-video Sentry project (not a secret). */
const SENTRY_DSN =
  'https://6cd948aa99f6c1fbb8df9c4df47f284d@o913766.ingest.us.sentry.io/4511810800713728'

/** Only real deployments report — dev servers and test runs stay silent. */
const REPORTING_HOSTNAMES = new Set(['kody.video', 'kody-video.pages.dev'])

/** True when this origin is allowed to load Sentry / send crash reports. */
export function isReportingHostname(hostname?: string): boolean {
  const host =
    hostname ?? (typeof location !== 'undefined' ? location.hostname : '')
  return REPORTING_HOSTNAMES.has(host)
}

/**
 * Marker used by the monitoring setup agent when it throws a synthetic
 * uncaught error to verify the DSN. Not app code — drop it so drills do not
 * open triage issues.
 */
const MONITORING_SELF_TEST_MARKER = 'KodyVideoMonitoringSelfTest'

/**
 * Cloudflare Web Analytics injects this script on Pages/zone analytics.
 * It is not app-owned; older browsers lacking Array.prototype.at throw inside
 * it and pollute Sentry (e.g. KODY-VIDEO issues on beacon.min.js).
 */
const CLOUDFLARE_INSIGHTS_BEACON_URL_MARKER =
  'static.cloudflareinsights.com/beacon.min.js'

type FilterableStackFrame = {
  filename?: string
  abs_path?: string
}

type FilterableSentryEvent = {
  exception?: {
    values?: Array<{
      type?: string
      value?: string
      stacktrace?: { frames?: FilterableStackFrame[] }
    }>
  }
  message?: string
}

type SentryLike = {
  init: (options: Record<string, unknown>) => void
  captureException: (error: unknown, context?: Record<string, unknown>) => void
  captureMessage: (message: string, context?: Record<string, unknown>) => void
}

/** Set after the dynamic `@sentry/browser` import resolves on reporting hosts. */
let sentry: SentryLike | null = null
/** In-flight SDK load + init so early captures share one import. */
let sentryLoad: Promise<SentryLike> | null = null

/** True for intentional monitoring self-test events (narrow signature only). */
export function isMonitoringSelfTestEvent(event: FilterableSentryEvent): boolean {
  const exceptionValues = event.exception?.values ?? []
  for (const value of exceptionValues) {
    if (value.value?.includes(MONITORING_SELF_TEST_MARKER)) return true
  }
  return (
    typeof event.message === 'string' &&
    event.message.includes(MONITORING_SELF_TEST_MARKER)
  )
}

/**
 * Soft project-cap / free-plan gate (createProject). Expected UX noise —
 * drop even if something captures outside reportError.
 */
export function isProjectLimitEvent(event: FilterableSentryEvent): boolean {
  const exceptionValues = event.exception?.values ?? []
  for (const value of exceptionValues) {
    if (value.type === 'ProjectLimitError') return true
    const text = value.value ?? ''
    if (text.includes('The free plan includes 1 project')) return true
    if (/^Project limit reached \(\d+\)/.test(text)) return true
  }
  return false
}

/**
 * Browser-extension / host-bridge noise (often Edge/Chrome on Windows).
 * Rejects a non-Error string like
 * "Object Not Found Matching Id:1, MethodName:update, ParamCount:4" with no
 * app stack — not from Kody Video (no chrome.tabs / extension surface).
 * KODY-VIDEO-H.
 */
const BROWSER_EXTENSION_HOST_OBJECT_NOISE =
  /Object Not Found Matching Id:\d+, MethodName:\w+, ParamCount:\d+/

export function isBrowserExtensionHostObjectNoiseEvent(
  event: FilterableSentryEvent,
): boolean {
  const exceptionValues = event.exception?.values ?? []
  for (const value of exceptionValues) {
    if (BROWSER_EXTENSION_HOST_OBJECT_NOISE.test(value.value ?? '')) return true
  }
  return (
    typeof event.message === 'string' &&
    BROWSER_EXTENSION_HOST_OBJECT_NOISE.test(event.message)
  )
}

function frameUrl(frame: FilterableStackFrame): string {
  return frame.abs_path ?? frame.filename ?? ''
}

/**
 * True when every stack frame we have is from Cloudflare Insights' beacon
 * (no app frames). Narrow: mixed stacks still report.
 */
export function isCloudflareInsightsBeaconEvent(
  event: FilterableSentryEvent,
): boolean {
  const frames = (event.exception?.values ?? []).flatMap(
    (value) => value.stacktrace?.frames ?? [],
  )
  if (frames.length === 0) return false
  return frames.every((frame) =>
    frameUrl(frame).includes(CLOUDFLARE_INSIGHTS_BEACON_URL_MARKER),
  )
}

/**
 * Vite's CSS preload helper rejects when a hashed stylesheet link errors
 * (deploy/edge race, stale HTTP cache, brief network blip). Same class as
 * the boot/lazy-page chunk recoveries — not an app logic bug. Narrow match
 * on Vite's exact message (KODY-VIDEO-J).
 */
export function isViteCssPreloadError(event: FilterableSentryEvent): boolean {
  const exceptionValues = event.exception?.values ?? []
  for (const value of exceptionValues) {
    const text = value.value ?? ''
    if (/^Unable to preload CSS for \S+/.test(text)) return true
  }
  return (
    typeof event.message === 'string' &&
    /^Unable to preload CSS for \S+/.test(event.message)
  )
}

/** Marker set while an export runs; still present at boot = the page died
 * mid-export (tab crash / out-of-memory kill — no JS error ever fires). */
const EXPORT_MARKER_KEY = 'kodyVideo.exportInFlight'

export function markExportStarted(info: Record<string, unknown>): void {
  try {
    sessionStorage.setItem(EXPORT_MARKER_KEY, JSON.stringify({ ...info, startedAt: Date.now() }))
  } catch {
    // Storage unavailable — we just lose this diagnostic.
  }
}

export function clearExportMarker(): void {
  try {
    sessionStorage.removeItem(EXPORT_MARKER_KEY)
  } catch {
    // Ignore.
  }
}

function reportExportSessionDeath(client: SentryLike): void {
  try {
    const raw = sessionStorage.getItem(EXPORT_MARKER_KEY)
    if (!raw) return
    sessionStorage.removeItem(EXPORT_MARKER_KEY)
    const info = JSON.parse(raw) as Record<string, unknown>
    client.captureMessage('Export session died (page reloaded mid-export, likely OOM/crash)', {
      level: 'error',
      tags: { step: 'export-crash' },
      extra: info,
    })
  } catch {
    // Ignore.
  }
}

/**
 * Coarse, non-identifying platform tags. Stripping request metadata (see
 * beforeSend) also strips the user agent, which left events with no platform
 * signal at all — triage of the iOS silent-mic report was blind to the OS.
 * Family-level names only; this matches the privacy page's "browser/OS".
 */
export function coarsePlatformTags(): Record<string, string> {
  const ua = navigator.userAgent
  const isIos =
    /iPhone|iPad|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const os = isIos
    ? 'ios'
    : /Android/i.test(ua)
      ? 'android'
      : /Mac OS X/.test(ua)
        ? 'macos'
        : /Windows/i.test(ua)
          ? 'windows'
          : /Linux|CrOS/i.test(ua)
            ? 'linux'
            : 'other'
  const browser = /Edg(?:e|A|iOS)?\//.test(ua)
    ? 'edge'
    : /SamsungBrowser/i.test(ua)
      ? 'samsung'
      : /OPR\/|OPT\//.test(ua)
        ? 'opera'
        : /Firefox\/|FxiOS/i.test(ua)
          ? 'firefox'
          : /CriOS|Chrome\//.test(ua)
            ? 'brave' in navigator
              ? 'brave'
              : 'chrome'
            : /Safari/i.test(ua)
              ? 'safari'
              : 'other'
  const installed =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true
  return { 'app.os': os, 'app.browser': browser, 'app.installed': String(installed) }
}

/**
 * Load only the crash-reporting surface from `@sentry/browser`.
 * Assigning the whole module namespace kept Session Replay / rrweb in the
 * chunk (Legacy JS Array.from override + ~500KB), even though we never
 * enable replay.
 */
function loadSentry(): Promise<SentryLike> | null {
  // Belt-and-suspenders: every capture path must stay silent off reporting hosts
  // (Vite HMR glitches on localhost must never open triage issues).
  if (!isReportingHostname()) return null
  if (sentry) return Promise.resolve(sentry)
  if (sentryLoad) return sentryLoad

  sentryLoad = import('@sentry/browser').then(({ init, captureException, captureMessage }) => {
    const client: SentryLike = { init, captureException, captureMessage }
    client.init({
      dsn: SENTRY_DSN,
      release: COMMIT_SHA,
      environment: location.hostname === 'kody.video' ? 'production' : 'legacy-pages-dev',
      initialScope: { tags: coarsePlatformTags() },
      // Crash reports only: no tracing, no session replay, no PII. Clips and
      // media never leave the device — this reports errors and stack traces.
      // These settings ENFORCE the privacy-page wording ("error message, stack
      // trace, browser/OS, failed step — nothing else"); keep them in sync.
      sendDefaultPii: false,
      tracesSampleRate: 0,
      maxBreadcrumbs: 0,
      beforeBreadcrumb: () => null,
      beforeSend(event: FilterableSentryEvent & Record<string, unknown>) {
        // Never attach user context (Sentry would otherwise infer an IP-based
        // user) or request metadata (URL/headers).
        delete event.user
        delete event.request
        if (isMonitoringSelfTestEvent(event)) return null
        if (isCloudflareInsightsBeaconEvent(event)) return null
        if (isProjectLimitEvent(event)) return null
        if (isBrowserExtensionHostObjectNoiseEvent(event)) return null
        if (isViteCssPreloadError(event)) return null
        return event
      },
    })
    sentry = client
    reportExportSessionDeath(client)
    return client
  })

  return sentryLoad
}

/**
 * Schedule Sentry after the home shell is interactive. PSI / Lighthouse still
 * see a hostname-gated import eventually; idle defer keeps it off the LCP
 * critical request chain.
 */
export function initErrorReporting(): void {
  if (!isReportingHostname()) return

  const start = () => {
    void loadSentry()?.catch(() => undefined)
  }

  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(start, { timeout: 4000 })
    return
  }
  window.setTimeout(start, 2500)
}

/**
 * True for expected product gates that must never become crash reports.
 * Matched by `error.name` so this module stays free of a storage import
 * (storage pulls idb/OPFS; reportError is on the idle-deferred Sentry path).
 */
export function isExpectedUserError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ProjectLimitError'
}

/**
 * Explicit capture for errors we catch and surface as in-app messages
 * (export error sheet, import error banner, …) — the user sees a friendly
 * message, we see the cause. The step lands as a searchable Sentry tag.
 */
export function reportError(
  error: unknown,
  step: string,
  extra?: Record<string, unknown>,
): void {
  // Plan/project caps are product UX (toast / upsell), not failures to triage.
  if (isExpectedUserError(error)) return
  if (!isReportingHostname()) return

  if (sentry) {
    sentry.captureException(error, { tags: { step }, ...(extra ? { extra } : {}) })
    return
  }
  // SDK still loading / idle-deferred — queue via the shared loader.
  void loadSentry()
    ?.then((client) => {
      client.captureException(error, { tags: { step }, ...(extra ? { extra } : {}) })
    })
    .catch(() => undefined)
}

/**
 * Remix component errors surface on the virtual root's `error` event instead
 * of window.onerror — without this, UI crashes would never reach Sentry.
 * The mechanism: main.tsx wires `root.addEventListener('error', …)` to this.
 */
export function reportComponentError(error: unknown): void {
  console.error('Uncaught component error', error)
  if (!isReportingHostname()) return
  if (sentry) {
    sentry.captureException(error, {
      mechanism: { type: 'remix.componentError', handled: false },
    })
    return
  }
  void loadSentry()
    ?.then((client) => {
      client.captureException(error, {
        mechanism: { type: 'remix.componentError', handled: false },
      })
    })
    .catch(() => undefined)
}
