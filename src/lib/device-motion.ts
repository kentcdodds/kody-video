import {
  createShakeDetector,
  shakeSampleFromRotationRate,
  type ShakeSample,
  type SwingReport,
} from './shake-gesture'

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
  const debug = shakeDebugOn ? createShakeDebugOverlay(options.signal) : null
  const detector = createShakeDetector({}, debug?.onSwing)
  const onMotion = (event: DeviceMotionEvent) => {
    const enabled = options.isEnabled()
    const rate = event.rotationRate
    const sample = rate ? shakeSampleFromRotationRate(rate, event.timeStamp, screenAngle()) : null
    debug?.onSample(sample, enabled)
    if (!enabled) {
      detector.reset()
      return
    }
    if (sample && detector.push(sample)) {
      debug?.onShake()
      options.onShake()
    }
  }
  window.addEventListener('devicemotion', onMotion, { signal: options.signal })
}

const SHAKE_DEBUG_KEY = 'kody-video:shake-debug'

/** `?shakeDebug` (sticky for the tab) shows live motion data for tuning. */
function shakeDebugEnabled(): boolean {
  try {
    const params = new URLSearchParams(location.search)
    if (params.has('shakeDebug')) {
      if (params.get('shakeDebug') === '0') sessionStorage.removeItem(SHAKE_DEBUG_KEY)
      else sessionStorage.setItem(SHAKE_DEBUG_KEY, '1')
    }
    return sessionStorage.getItem(SHAKE_DEBUG_KEY) === '1'
  } catch {
    return false
  }
}

// Read on load: the home page URL carries the flag, the camera route doesn't.
const shakeDebugOn = typeof location !== 'undefined' && shakeDebugEnabled()

function createShakeDebugOverlay(signal: AbortSignal) {
  const el = document.createElement('pre')
  el.setAttribute('aria-hidden', 'true')
  el.style.cssText =
    'position:fixed;left:8px;top:64px;z-index:99999;margin:0;padding:8px;' +
    'font:11px/1.35 ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.72);' +
    'border-radius:8px;pointer-events:none;white-space:pre;max-width:92vw'
  document.body.append(el)
  signal.addEventListener('abort', () => el.remove())

  const recent: ShakeSample[] = []
  const swings: string[] = []
  let events = 0
  let nullRates = 0
  let enabled = false
  let shakes = 0
  let frame = 0

  const render = () => {
    frame = 0
    const now = recent.at(-1)?.t ?? 0
    while (recent.length > 0 && now - recent[0]!.t > 1000) recent.shift()
    const peak = (axis: 'yaw' | 'pitch' | 'roll') =>
      Math.round(Math.max(0, ...recent.map((sample) => Math.abs(sample[axis]))))
    el.textContent = [
      `shake debug  events ${events}  no-gyro ${nullRates}  shakes ${shakes}`,
      `enabled ${enabled}  angle ${screenAngle()}  rate ${recent.length}/s`,
      `peak 1s deg/s  yaw ${peak('yaw')}  pitch ${peak('pitch')}  roll ${peak('roll')}`,
      'swings (newest first):',
      ...swings,
    ].join('\n')
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(render)
  }
  signal.addEventListener('abort', () => cancelAnimationFrame(frame))
  render()

  return {
    onSample(sample: ShakeSample | null, isEnabled: boolean) {
      events += 1
      enabled = isEnabled
      if (sample) recent.push(sample)
      else nullRates += 1
      schedule()
    },
    onSwing(report: SwingReport) {
      const dir = report.sign > 0 ? '+' : '-'
      swings.unshift(
        `${dir} peak ${Math.round(report.peak)} other ${Math.round(report.peakOther)} ` +
          `${Math.round(report.durationMs)}ms ${report.verdict} chain ${report.chainLength}`,
      )
      swings.length = Math.min(swings.length, 8)
      schedule()
    },
    onShake() {
      shakes += 1
      schedule()
    },
  }
}
