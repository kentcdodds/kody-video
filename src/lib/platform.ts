/** Coarse browser/platform checks shared across capture and chrome. */

export function isMobileBrowser(): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}

/** All iOS browsers share WebKit (and its quirks), whatever their brand. */
export function isIosBrowser(): boolean {
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return true
  // iPadOS masquerades as macOS but is the only "Mac" with touch points.
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}
