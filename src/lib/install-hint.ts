/**
 * iOS never fires `beforeinstallprompt`, so the only way to get Kody Video on
 * a home screen there is the manual Share → Add to Home Screen flow. This
 * decides when nudging about that is actually useful.
 */

import { isIosBrowser, isStandaloneDisplay } from './platform'

const DISMISSED_KEY = 'kody-video:install-hint-dismissed'

export function shouldShowIosInstallHint(): boolean {
  if (!isIosBrowser()) return false
  if (isStandaloneDisplay()) return false
  // Bare WKWebViews (X, Instagram, …) have no Share → Add to Home Screen and
  // omit the "Safari" UA token that real browsers (Safari/CriOS/FxiOS) keep.
  if (!/Safari/i.test(navigator.userAgent)) return false
  try {
    return localStorage.getItem(DISMISSED_KEY) === null
  } catch {
    return true
  }
}

export function dismissIosInstallHint(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()))
  } catch {
    // Private mode without storage — the hint just reappears next visit.
  }
}
