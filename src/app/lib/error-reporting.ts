/**
 * Error reporting, no-dependency edition: no external crash service, no SDK.
 * Failures are logged to the console with the same step tags the app used
 * to send to Sentry, so local debugging keeps its context. The mid-export
 * crash marker survives reloads via sessionStorage and is surfaced at boot.
 */

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
    console.error(
      'Export session died (page reloaded mid-export, likely OOM/crash)',
      JSON.parse(raw),
    )
  } catch {
    // Ignore.
  }
}

export function initErrorReporting(): void {
  reportExportSessionDeath()
}

/**
 * Explicit capture for errors we catch and surface as in-app messages
 * (export error sheet, import error banner, …) — the user sees a friendly
 * message, the console sees the cause and the failing step.
 */
export function reportError(error: unknown, step: string, extra?: Record<string, unknown>): void {
  if (extra !== undefined) console.error(`[${step}]`, error, extra)
  else console.error(`[${step}]`, error)
}

export function reportComponentError(error: unknown): void {
  console.error('Uncaught component error', error)
}
