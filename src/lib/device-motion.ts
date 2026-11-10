import { createShakeDetector, shakeSampleFromRotationRate } from './shake-gesture'

type MotionEventWithPermission = typeof DeviceMotionEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>
}

let permissionRequested = false

/**
 * iOS gates device motion behind `DeviceMotionEvent.requestPermission()`,
 * which only works inside a user gesture. Call this synchronously from an
 * existing tap; it asks at most once per page load and fails silently
 * (denied or unsupported just means no shake gestures).
 */
export function requestMotionPermission(): void {
  if (permissionRequested) return
  if (typeof DeviceMotionEvent === 'undefined') return
  const motion = DeviceMotionEvent as MotionEventWithPermission
  if (typeof motion.requestPermission !== 'function') return
  permissionRequested = true
  try {
    void motion.requestPermission().catch(() => undefined)
  } catch {
    // Some WebKit builds throw synchronously outside a gesture.
  }
}

function screenAngle(): number {
  const angle = screen.orientation?.angle
  if (typeof angle === 'number') return angle
  // Older iOS Safari only has the legacy window.orientation.
  const legacy = (window as { orientation?: number }).orientation
  return typeof legacy === 'number' ? legacy : 0
}

/**
 * Calls `onShake` when the phone is shaken like a head saying "no".
 * `isEnabled` is read per event: while it is false, partial shakes are
 * dropped so motion during a take can't complete a gesture afterward.
 */
export function listenForShake(options: {
  onShake: () => void
  isEnabled: () => boolean
  signal: AbortSignal
}): void {
  if (typeof window === 'undefined' || typeof DeviceMotionEvent === 'undefined') return
  const detector = createShakeDetector()
  const onMotion = (event: DeviceMotionEvent) => {
    if (!options.isEnabled()) {
      detector.reset()
      return
    }
    const rate = event.rotationRate
    if (!rate) return
    const sample = shakeSampleFromRotationRate(rate, event.timeStamp, screenAngle())
    if (sample && detector.push(sample)) options.onShake()
  }
  window.addEventListener('devicemotion', onMotion, { signal: options.signal })
}
