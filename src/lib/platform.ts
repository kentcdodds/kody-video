/** Coarse browser/platform checks shared across capture and chrome. */

export function isMobileBrowser(): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}

interface PlatformOverrides {
  coarsePointer?: boolean
  viewportLandscape?: boolean
  orientationAngle?: number
}

/** Test seam: headless Chromium always reports a fine pointer and a
 * landscape window, so touch-device flows are unreachable without it. */
let platformOverrides: PlatformOverrides = {}

export function setPlatformOverridesForTests(overrides: PlatformOverrides): void {
  platformOverrides = overrides
}

/**
 * True on devices whose PRIMARY pointer is a finger (phones, tablets) —
 * where physically rotating the device is a deliberate orientation choice.
 * Touchscreen laptops report their mouse/trackpad as primary and stay fine.
 */
export function isCoarsePointerDevice(): boolean {
  if (platformOverrides.coarsePointer !== undefined) return platformOverrides.coarsePointer
  return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
}

/** How the device is currently held (viewport orientation). */
export function viewportIsLandscape(): boolean {
  if (platformOverrides.viewportLandscape !== undefined) {
    return platformOverrides.viewportLandscape
  }
  return typeof window !== 'undefined' && window.matchMedia('(orientation: landscape)').matches
}

/**
 * Clockwise degrees the OS turned the layout by to keep it upright (0 = the
 * device's natural orientation). Missing API = assume natural.
 */
export function viewportOrientationAngle(): number {
  if (platformOverrides.orientationAngle !== undefined) {
    return platformOverrides.orientationAngle
  }
  if (typeof screen === 'undefined') return 0
  return screen.orientation?.angle ?? 0
}

/** All iOS browsers share WebKit (and its quirks), whatever their brand. */
export function isIosBrowser(): boolean {
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return true
  // iPadOS masquerades as macOS but is the only "Mac" with touch points.
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}
