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
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend(event) {
      // Belt and braces: never attach user context (Sentry would otherwise
      // infer an IP-based user for browser events).
      delete event.user
      return event
    },
  })
}

/**
 * Explicit capture for errors we catch and soften into toasts (export or
 * import failures, …) — the user sees a friendly message, we see the cause.
 */
export function reportError(error: unknown, context?: Record<string, unknown>): void {
  Sentry.captureException(error, context ? { extra: context } : undefined)
}

/**
 * React 19 routes uncaught render errors through createRoot options instead
 * of window.onerror — without these, UI crashes would never reach Sentry.
 * The console callbacks preserve React's default logging behavior.
 */
export const reactRootErrorHandlers = {
  onUncaughtError: Sentry.reactErrorHandler((error, errorInfo) => {
    console.error('Uncaught React error', error, errorInfo.componentStack)
  }),
  onCaughtError: Sentry.reactErrorHandler(),
  onRecoverableError: Sentry.reactErrorHandler((error, errorInfo) => {
    console.warn('Recoverable React error', error, errorInfo.componentStack)
  }),
}
