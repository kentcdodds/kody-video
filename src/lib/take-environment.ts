import { coarsePlatformTags } from './error-reporting'
import type { TakeCamera, TakeEnvironment } from './take-report'

/**
 * Environment signals for take reports, read synchronously at the press.
 * Battery (Chromium) and Compute Pressure (a CPU/thermal proxy, where
 * supported) are asynchronous sources, so they are watched once per
 * page and the latest value is used. Nothing here identifies the device.
 */

interface BatteryLike extends EventTarget {
  level: number
  charging: boolean
}

interface PressureRecordLike {
  state: string
}

type PressureObserverCtor = new (callback: (records: PressureRecordLike[]) => void) => {
  observe(source: 'cpu'): Promise<void>
}

let watching = false
let battery: BatteryLike | null = null
let pressureState: string | undefined

/** Start the battery / pressure watches (idempotent, best-effort). */
export function watchCaptureEnvironment(): void {
  if (watching || typeof navigator === 'undefined') return
  watching = true
  const getBattery = (navigator as Navigator & { getBattery?: () => Promise<BatteryLike> })
    .getBattery
  if (typeof getBattery === 'function') {
    getBattery
      .call(navigator)
      .then((manager) => {
        battery = manager
      })
      .catch(() => undefined)
  }
  const Pressure = (globalThis as { PressureObserver?: PressureObserverCtor }).PressureObserver
  if (typeof Pressure === 'function') {
    try {
      const observer = new Pressure((records) => {
        pressureState = records.at(-1)?.state ?? pressureState
      })
      void observer.observe('cpu').catch(() => undefined)
    } catch {
      // Permissions policy or platform refused — no pressure signal.
    }
  }
}

export function snapshotEnvironment(input: {
  cameraOpenedAt: number
  takeIndex: number
  previousSaveInFlight: boolean
  idleEncoder: { sessions: number; encodeMs: number }
}): TakeEnvironment {
  const tags = coarsePlatformTags()
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  return {
    os: tags['app.os'] ?? 'other',
    browser: tags['app.browser'] ?? 'other',
    installed: tags['app.installed'] === 'true',
    ...(navigator.hardwareConcurrency ? { cores: navigator.hardwareConcurrency } : {}),
    ...(typeof memory === 'number' ? { memoryGb: memory } : {}),
    ...(battery
      ? { battery: { level: Math.round(battery.level * 100) / 100, charging: battery.charging } }
      : {}),
    ...(pressureState ? { pressure: pressureState } : {}),
    cameraOpenMs: Math.max(0, Math.round(performance.now() - input.cameraOpenedAt)),
    takeIndex: input.takeIndex,
    previousSaveInFlight: input.previousSaveInFlight,
    idleEncoder: input.idleEncoder,
  }
}

interface ZoomSettings extends MediaTrackSettings {
  zoom?: number
}

export function snapshotCamera(track: MediaStreamTrack | undefined): TakeCamera {
  try {
    const settings = (track?.getSettings() ?? {}) as ZoomSettings
    return {
      ...(settings.width ? { width: settings.width } : {}),
      ...(settings.height ? { height: settings.height } : {}),
      ...(settings.frameRate ? { frameRate: Math.round(settings.frameRate * 10) / 10 } : {}),
      ...(settings.facingMode ? { facingMode: settings.facingMode } : {}),
      ...(typeof settings.zoom === 'number' ? { zoom: Math.round(settings.zoom * 100) / 100 } : {}),
    }
  } catch {
    return {}
  }
}
