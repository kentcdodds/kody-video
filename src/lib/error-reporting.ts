import * as Sentry from '@sentry/react'
import type { ErrorInfo } from 'react'

/** Publishable client key for the kody-video Sentry project (not a secret). */
const SENTRY_DSN =
  'https://6cd948aa99f6c1fbb8df9c4df47f284d@o913766.ingest.us.sentry.io/4511810800713728'

/** Only real deployments report — dev servers and test runs stay silent. */
const REPORTING_HOSTNAMES = new Set(['kody.video', 'kody-video.pages.dev'])

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

declare const __COMMIT_SHA__: string

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

function reportExportSessionDeath(): void {
  try {
    const raw = sessionStorage.getItem(EXPORT_MARKER_KEY)
    if (!raw) return
    sessionStorage.removeItem(EXPORT_MARKER_KEY)
    const info = JSON.parse(raw) as Record<string, unknown>
    Sentry.captureMessage('Export session died (page reloaded mid-export, likely OOM/crash)', {
      level: 'error',
      tags: { step: 'export-crash' },
      extra: info,
    })
  } catch {
    // Ignore.
  }
}

export function initErrorReporting(): void {
  if (!REPORTING_HOSTNAMES.has(location.hostname)) return
  Sentry.init({
    dsn: SENTRY_DSN,
    release: __COMMIT_SHA__,
    environment: location.hostname === 'kody.video' ? 'production' : 'legacy-pages-dev',
    // Crash reports only: no tracing, no session replay, no PII. Clips and
    // media never leave the device — this reports errors and stack traces.
    // These settings ENFORCE the privacy-page wording ("error message, stack
    // trace, browser/OS, failed step — nothing else"); keep them in sync.
    sendDefaultPii: false,
    tracesSampleRate: 0,
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    beforeSend(event) {
      // Never attach user context (Sentry would otherwise infer an IP-based
      // user) or request metadata (URL/headers).
      delete event.user
      delete event.request
      if (isMonitoringSelfTestEvent(event)) return null
      if (isCloudflareInsightsBeaconEvent(event)) return null
      return event
    },
  })
  reportExportSessionDeath()
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
  Sentry.captureException(error, { tags: { step }, ...(extra ? { extra } : {}) })
}

/**
 * React 19 routes uncaught render errors through createRoot options instead
 * of window.onerror — without these, UI crashes would never reach Sentry.
 *
 * Classification subtlety: `reactErrorHandler(callback)` marks the event
 * handled, `reactErrorHandler()` marks it unhandled. Uncaught root errors
 * must stay *unhandled*, so their console logging wraps the capture instead
 * of being passed as the callback.
 */
const captureUncaughtReactError = Sentry.reactErrorHandler()

export const reactRootErrorHandlers = {
  onUncaughtError: (error: unknown, errorInfo: ErrorInfo) => {
    console.error('Uncaught React error', error, errorInfo.componentStack)
    captureUncaughtReactError(error, errorInfo)
  },
  onCaughtError: Sentry.reactErrorHandler((error, errorInfo) => {
    console.error('Caught React error', error, errorInfo.componentStack)
  }),
  onRecoverableError: Sentry.reactErrorHandler((error, errorInfo) => {
    console.warn('Recoverable React error', error, errorInfo.componentStack)
  }),
}
