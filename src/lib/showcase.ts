/**
 * This branch is the archived pre-rewrite React edition of Kody Video, kept
 * online as a showcase (react.kody.video). Every deployment of it should
 * point visitors at the real app and at the PR where the agent analyzed the
 * React → Remix 3 port, so the banner shows on any non-local hostname.
 */

export const SHOWCASE_EDITION = 'archived React edition'
export const SHOWCASE_PR_URL = 'https://github.com/kentcdodds/kody-video/pull/87'
export const SHOWCASE_PR_NUMBER = 87

const DISMISSED_KEY = 'kody-video:showcase-banner-dismissed'

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.local')
}

export function shouldShowShowcaseBanner(): boolean {
  if (isLocalHostname(location.hostname)) return false
  try {
    return localStorage.getItem(DISMISSED_KEY) === null
  } catch {
    return true
  }
}

export function dismissShowcaseBanner(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()))
  } catch {
    // Private mode without storage — the banner just reappears next visit.
  }
}
