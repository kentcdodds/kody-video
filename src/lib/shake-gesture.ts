/**
 * "Head shaking no" detector: the phone, held upright, twisted quickly
 * left-right-left around the axis that runs up and down the screen as held.
 * Pure: feed it rotation-rate samples, it answers whether a shake just
 * completed. The device-motion glue lives in `device-motion.ts`.
 *
 * A shake is `minSwings` alternating swings, each a run of same-sign yaw
 * rate that peaks at `minPeakRate` while clearly dominating the other two
 * axes. Swings must follow each other closely (`maxGapMs`) and the whole
 * run must fit in `windowMs`, so walking, panning, or a single turn (even
 * one with a small rebound) never adds up to one.
 */

/** Rotation rates in deg/s, already mapped to the axes as the phone is held. */
export interface ShakeSample {
  /** Milliseconds (event timeStamp / performance.now()). */
  t: number
  /** Around the vertical axis of the held screen: the "no" twist. */
  yaw: number
  /** Around the horizontal axis of the held screen: a nod. */
  pitch: number
  /** Around the axis out of the screen: a fan or wiper motion. */
  roll: number
}

export interface ShakeOptions {
  /** Yaw rate (deg/s) that opens a swing. */
  startRate: number
  /** A swing ends once yaw falls below this or changes sign (hysteresis). */
  releaseRate: number
  /** Peak yaw rate (deg/s) a swing must reach to count. */
  minPeakRate: number
  /** A swing's peak yaw must be this many times the peak of the other axes. */
  dominance: number
  /** Swings longer than this are a turn or a pan, not a shake. */
  maxSwingMs: number
  /** Longest pause allowed between one swing ending and the next starting. */
  maxGapMs: number
  /** Alternating swings needed: 3 = left-right-left. */
  minSwings: number
  /** All counted swings must fit in this window (first start to last end). */
  windowMs: number
  /** Ignore motion for this long after a shake fires. */
  cooldownMs: number
  /** A gap between samples longer than this (sensor paused) resets. */
  maxSampleGapMs: number
}

export const defaultShakeOptions: ShakeOptions = {
  startRate: 90,
  releaseRate: 60,
  minPeakRate: 200,
  dominance: 1.5,
  maxSwingMs: 500,
  maxGapMs: 250,
  minSwings: 3,
  windowMs: 1200,
  cooldownMs: 1000,
  maxSampleGapMs: 250,
}

interface Swing {
  sign: 1 | -1
  start: number
  end: number
  peak: number
  peakOther: number
}

export interface ShakeDetector {
  /** Feed one sample; true exactly when a shake completes. */
  push: (sample: ShakeSample) => boolean
  /** Forget any partial shake (e.g. while recording). Keeps the cooldown. */
  reset: () => void
}

export function createShakeDetector(overrides: Partial<ShakeOptions> = {}): ShakeDetector {
  const options = { ...defaultShakeOptions, ...overrides }
  let current: Swing | null = null
  let chain: Swing[] = []
  let lastT: number | null = null
  let cooldownUntil = Number.NEGATIVE_INFINITY

  const reset = () => {
    current = null
    chain = []
  }

  const qualifies = (swing: Swing) =>
    swing.peak >= options.minPeakRate &&
    swing.peak >= options.dominance * swing.peakOther &&
    swing.end - swing.start <= options.maxSwingMs

  /** Adds a finished swing to the chain; true when the chain is a shake. */
  const finish = (swing: Swing): boolean => {
    if (!qualifies(swing)) {
      // A big off-axis or too-long swing is some other motion: start over.
      chain = []
      return false
    }
    const previous = chain.at(-1)
    if (
      previous &&
      (previous.sign === swing.sign || swing.start - previous.end > options.maxGapMs)
    ) {
      chain = []
    }
    chain.push(swing)
    while (chain.length > 0 && swing.end - chain[0]!.start > options.windowMs) chain.shift()
    return chain.length >= options.minSwings
  }

  const push = (sample: ShakeSample): boolean => {
    const { t } = sample
    if (lastT !== null && (t < lastT || t - lastT > options.maxSampleGapMs)) reset()
    lastT = t
    if (t < cooldownUntil) return false

    const rate = Math.abs(sample.yaw)
    const sign: 1 | -1 = sample.yaw >= 0 ? 1 : -1
    const other = Math.max(Math.abs(sample.pitch), Math.abs(sample.roll))

    let fired = false
    if (current) {
      if (sign === current.sign && rate >= options.releaseRate) {
        current.end = t
        current.peak = Math.max(current.peak, rate)
        current.peakOther = Math.max(current.peakOther, other)
        return false
      }
      const done = current
      current = null
      fired = finish(done)
    }
    if (fired) {
      reset()
      cooldownUntil = t + options.cooldownMs
      return true
    }
    if (rate >= options.startRate) {
      current = { sign, start: t, end: t, peak: rate, peakOther: other }
    }
    return false
  }

  return { push, reset }
}

/** `DeviceMotionEvent.rotationRate`: alpha/beta/gamma are the device's
 * x/y/z axes (deg/s) per the W3C Device Orientation spec. */
export interface RotationRateLike {
  alpha: number | null
  beta: number | null
  gamma: number | null
}

/**
 * Maps device-frame rates to the held screen. Device y runs up the
 * portrait screen, so it is the "no" axis in portrait; turned to
 * landscape (screen angle 90 or 270) the vertical axis is device x.
 * Signs don't matter to the detector, only alternation does.
 */
export function shakeSampleFromRotationRate(
  rate: RotationRateLike,
  t: number,
  screenAngle: number,
): ShakeSample | null {
  const { alpha: x, beta: y, gamma: z } = rate
  if (x == null || y == null || z == null) return null
  const landscape = Math.abs(((screenAngle % 180) + 180) % 180) === 90
  return landscape ? { t, yaw: x, pitch: y, roll: z } : { t, yaw: y, pitch: x, roll: z }
}
