/**
 * Pinning a locked project's interface to the device.
 *
 * A project with clips is locked to one orientation, and a locked interface
 * must not reflow when the device turns — same as a native camera app.
 * `screen.orientation.lock()` does exactly that, but only inside installed
 * PWAs on some platforms (iOS has no support at all), so everywhere else the
 * shell counter-rotates the OS's auto-rotate away: the app keeps rendering
 * in the locked shape and simply appears sideways until the device is held
 * the way the project wants.
 *
 * Counter-rotating the shell rotates the coordinate space every drag gesture
 * lives in — `clientX/clientY` stay in viewport space while the elements
 * they are compared against are rotated, and a `DOMRect` degrades to the
 * axis-aligned box around a rotated element. `contentX/contentY` (and the
 * matching rect accessors) project both onto the shell's OWN axes, so
 * gesture math reads the same at every rotation.
 *
 * Those axes point the right way but carry an arbitrary origin (the viewport
 * offset the rotation translates by is dropped as noise). Everything gesture
 * math does is relative — a delta, a comparison, or a position within a rect
 * — so the offset cancels; an absolute "how far from the top of the screen"
 * would NOT be valid.
 */

/** Clockwise degrees the shell is rotated by (0 = following the device). */
export type ShellRotation = 0 | 90 | -90

export interface ClientPoint {
  clientX: number
  clientY: number
}

/** A rect's extent along one of the shell's own axes. */
export interface ContentExtent {
  start: number
  end: number
  size: number
}

let rotation: ShellRotation = 0

export function shellRotation(): ShellRotation {
  return rotation
}

/**
 * Rotate the shell (and expose it to CSS as `<html data-rotate>`). Idempotent
 * so callers can re-assert the current rotation on every render.
 */
export function setShellRotation(next: ShellRotation): void {
  rotation = next
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (next === 0) delete root.dataset.rotate
  else root.dataset.rotate = next === 90 ? 'cw' : 'ccw'
}

/**
 * The rotation that keeps `locked` on screen while the viewport reports
 * `viewportLandscape`: none while the two already agree, otherwise the turn
 * that undoes the device's own (`angle` = `screen.orientation.angle`, the
 * clockwise angle the OS rotated the layout to by).
 */
export function rotationForLock(
  locked: 'portrait' | 'landscape',
  viewportLandscape: boolean,
  angle: number,
): ShellRotation {
  if (viewportLandscape === (locked === 'landscape')) return 0
  const normalized = ((Math.round(angle / 90) * 90) % 360 + 360) % 360
  // Undo the OS turn (90/270), or — for a device whose natural orientation
  // is the mismatching one — pick the turn toward the standard sideways
  // hold, so the interface lands upright once the device follows.
  if (normalized === 90) return -90
  if (normalized === 270) return 90
  return normalized === 180 ? -90 : 90
}

/** Pointer position along the shell's own horizontal axis. */
export function contentX(point: ClientPoint): number {
  if (rotation === 90) return point.clientY
  if (rotation === -90) return -point.clientY
  return point.clientX
}

/** Pointer position along the shell's own vertical axis. */
export function contentY(point: ClientPoint): number {
  if (rotation === 90) return -point.clientX
  if (rotation === -90) return point.clientX
  return point.clientY
}

/** Where a (rotated) element starts and ends on the shell's horizontal axis. */
export function contentExtentX(rect: DOMRect): ContentExtent {
  if (rotation === 90) return { start: rect.top, end: rect.bottom, size: rect.height }
  if (rotation === -90) return { start: -rect.bottom, end: -rect.top, size: rect.height }
  return { start: rect.left, end: rect.right, size: rect.width }
}

/** Where a (rotated) element starts and ends on the shell's vertical axis. */
export function contentExtentY(rect: DOMRect): ContentExtent {
  if (rotation === 90) return { start: -rect.right, end: -rect.left, size: rect.width }
  if (rotation === -90) return { start: rect.left, end: rect.right, size: rect.width }
  return { start: rect.top, end: rect.bottom, size: rect.height }
}

/** Test seam: drop any rotation (and its `<html>` attribute). */
export function resetShellRotationForTests(): void {
  setShellRotation(0)
}
