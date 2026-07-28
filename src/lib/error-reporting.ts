import * as Sentry from '@sentry/react'

/** Publishable client key for the kody-video Sentry project (not a secret). */
const SENTRY_DSN =
  'https://6cd948aa99f6c1fbb8df9c4df47f284d@o913766.ingest.us.sentry.io/4511810800713728'

/** Only real deployments report — dev servers and test runs stay silent. */
const REPORTING_HOSTNAMES = new Set(['kody.video', 'kody-video.pages.dev'])

declare const __COMMIT_SHA__: string

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
      return event
    },
  })
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
  onUncaughtError: (error: unknown, errorInfo: React.ErrorInfo) => {
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
