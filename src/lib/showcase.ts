/**
 * Kody Video keeps its rewrite experiments online as showcases (see the
 * "Rewrite showcases" section of the README). This module decides when the
 * current origin is one of those showcase deployments so the home screen can
 * point visitors at the real app and at the PR where the agent analyzed that
 * edition. The vanilla and TypeScript editions carry their own banner in
 * their branches; from this codebase the only showcase origin is the Remix
 * rewrite preview domain, which proxies the production build.
 */

export interface ShowcaseInfo {
  /** Human-readable name of the edition this origin showcases. */
  edition: string
  /** The PR containing the agent's analysis of this edition. */
  prUrl: string
  prNumber: number
}

const DISMISSED_KEY = 'kody-video:showcase-banner-dismissed'

export function showcaseForHostname(hostname: string): ShowcaseInfo | null {
  if (hostname === 'remix.kody.video') {
    return {
      edition: 'Remix 3 rewrite',
      prUrl: 'https://github.com/kentcdodds/kody-video/pull/87',
      prNumber: 87,
    }
  }
  return null
}

export function isShowcaseBannerDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) !== null
  } catch {
    return false
  }
}

export function dismissShowcaseBanner(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()))
  } catch {
    // Private mode without storage — the banner just reappears next visit.
  }
}
