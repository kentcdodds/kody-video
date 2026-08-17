/** Coarse browser/platform checks shared across capture and chrome. */

export function isMobileBrowser(): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}

interface PlatformOverrides {
  coarsePointer?: boolean
  viewportLandscape?: boolean
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

/**
 * True when the layout viewport is wider than it is tall.
 *
 * Do not use `matchMedia('(orientation: landscape)')` here: some Android
 * PWAs leave that CSS signal stuck on portrait after a physical rotate
 * (the window is already wide — mint gutters beside a 480px #root —
 * while the media query still says portrait). Layout aspect follows the
 * window the chrome actually has.
 */
export function viewportIsLandscape(): boolean {
  if (platformOverrides.viewportLandscape !== undefined) {
    return platformOverrides.viewportLandscape
  }
  if (typeof window === 'undefined') return false
  const width = window.innerWidth
  const height = window.innerHeight
  if (width > 0 && height > 0) return width > height
  const type = screen.orientation?.type
  if (typeof type === 'string') return type.startsWith('landscape')
  return window.matchMedia('(orientation: landscape)').matches
}

/** How a phone/tablet is held right now. Null on desktop — rotating a
 * window is not a film-orientation choice. */
export function heldDeviceOrientation(): 'portrait' | 'landscape' | null {
  if (!isCoarsePointerDevice()) return null
  return viewportIsLandscape() ? 'landscape' : 'portrait'
}


/**
 * Re-run when the hold may have changed. CSS orientation media can stay
 * silent on the Android PWA bug above, so this also listens to resize,
 * visualViewport, screen.orientation, and the legacy orientationchange.
 */
export function subscribeViewportOrientationChange(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  let frame = 0
  const fire = () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      onChange()
    })
  }
  const landscapeMedia = window.matchMedia('(orientation: landscape)')
  landscapeMedia.addEventListener('change', fire)
  window.addEventListener('resize', fire)
  window.addEventListener('orientationchange', fire)
  const visual = window.visualViewport
  visual?.addEventListener('resize', fire)
  const screenOrientation = screen.orientation
  screenOrientation?.addEventListener('change', fire)
  return () => {
    landscapeMedia.removeEventListener('change', fire)
    window.removeEventListener('resize', fire)
    window.removeEventListener('orientationchange', fire)
    visual?.removeEventListener('resize', fire)
    screenOrientation?.removeEventListener('change', fire)
    if (frame) cancelAnimationFrame(frame)
  }
}

/** All iOS browsers share WebKit (and its quirks), whatever their brand. */
export function isIosBrowser(): boolean {
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return true
  // iPadOS masquerades as macOS but is the only "Mac" with touch points.
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}
