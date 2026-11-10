import { describe, expect, it } from 'vitest'
import {
  createShakeDetector,
  shakeSampleFromRotationRate,
  type ShakeOptions,
  type ShakeSample,
} from './shake-gesture'

const HZ = 60
const STEP = 1000 / HZ

type Axis = 'yaw' | 'pitch' | 'roll'
type Rates = Partial<Record<Axis, number>>

/** Samples at 60 Hz for `ms`, rates from `at(elapsedMs)`, starting at `t0`. */
function sampled(ms: number, at: (elapsed: number) => Rates, t0 = 0): ShakeSample[] {
  const out: ShakeSample[] = []
  for (let elapsed = 0; elapsed < ms; elapsed += STEP) {
    const rates = at(elapsed)
    out.push({ t: t0 + elapsed, yaw: rates.yaw ?? 0, pitch: rates.pitch ?? 0, roll: rates.roll ?? 0 })
  }
  return out
}

/** Oscillation on one axis; `halfCycles` alternating swings, others get crosstalk. */
function oscillation(
  axis: Axis,
  { hz, amplitude, halfCycles, crosstalk = 0.1 }: {
    hz: number
    amplitude: number
    halfCycles: number
    crosstalk?: number
  },
  t0 = 0,
): ShakeSample[] {
  const ms = (halfCycles * 1000) / (2 * hz)
  return sampled(
    ms,
    (elapsed) => {
      const value = amplitude * Math.sin(2 * Math.PI * hz * (elapsed / 1000))
      const rates: Rates = { yaw: value * crosstalk, pitch: value * crosstalk, roll: value * crosstalk }
      rates[axis] = value
      return rates
    },
    t0,
  )
}

/** Deterministic noise in [-1, 1]. */
function noise(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return (state / 4294967296) * 2 - 1
  }
}

/** Feeds samples (plus a short still tail so a last swing can finish). */
function fireTimes(samples: ShakeSample[], options?: Partial<ShakeOptions>): number[] {
  const detector = createShakeDetector(options)
  const last = samples.at(-1)?.t ?? 0
  const tail = sampled(200, () => ({}), last + STEP)
  return [...samples, ...tail].filter((sample) => detector.push(sample)).map((s) => s.t)
}

describe('createShakeDetector', () => {
  it('fires on a quick left-right-left twist around the vertical axis', () => {
    expect(fireTimes(oscillation('yaw', { hz: 3, amplitude: 400, halfCycles: 3 }))).toHaveLength(1)
  })

  it('fires on a gentler 2 Hz shake that still peaks above the threshold', () => {
    expect(fireTimes(oscillation('yaw', { hz: 2, amplitude: 260, halfCycles: 3 }))).toHaveLength(1)
  })

  it('fires within the shake, not only after the phone settles', () => {
    const shake = oscillation('yaw', { hz: 3, amplitude: 400, halfCycles: 4 })
    const [time] = fireTimes(shake)
    expect(time).toBeDefined()
    expect(time!).toBeLessThanOrEqual(shake.at(-1)!.t)
  })

  it('ignores a left-right pair (only two swings)', () => {
    expect(fireTimes(oscillation('yaw', { hz: 3, amplitude: 400, halfCycles: 2 }))).toEqual([])
  })

  it('ignores a slow pan', () => {
    expect(fireTimes(sampled(2000, () => ({ yaw: 60, pitch: 5 })))).toEqual([])
  })

  it('ignores slow back-and-forth panning', () => {
    expect(fireTimes(oscillation('yaw', { hz: 0.5, amplitude: 150, halfCycles: 6 }))).toEqual([])
  })

  it('ignores a fast single turn with a rebound as it stops', () => {
    const turn = sampled(300, (elapsed) => ({ yaw: 320 * Math.sin((Math.PI * elapsed) / 300) }))
    const rebound = sampled(
      150,
      (elapsed) => ({ yaw: -110 * Math.sin((Math.PI * elapsed) / 150) }),
      300,
    )
    expect(fireTimes([...turn, ...rebound])).toEqual([])
  })

  it('ignores a long fast turn even when it alternates', () => {
    // Each swing lasts ~700ms: deliberate turning, not a shake.
    expect(fireTimes(oscillation('yaw', { hz: 0.7, amplitude: 300, halfCycles: 3 }))).toEqual([])
  })

  it('ignores walking-like noise', () => {
    const random = noise(42)
    const walk = sampled(10_000, (elapsed) => {
      const step = 2 * Math.PI * 1.8 * (elapsed / 1000)
      return {
        yaw: 45 * Math.sin(step) + 25 * random(),
        pitch: 70 * Math.sin(step * 2) + 30 * random(),
        roll: 40 * Math.sin(step) + 20 * random(),
      }
    })
    expect(fireTimes(walk)).toEqual([])
  })

  it('ignores a fan motion around the axis out of the screen (z)', () => {
    expect(
      fireTimes(oscillation('roll', { hz: 3, amplitude: 400, halfCycles: 6, crosstalk: 0.3 })),
    ).toEqual([])
  })

  it('ignores a fan motion that leaks a strong yaw rate', () => {
    // Yaw peaks at 220 deg/s (over the threshold) but z dominates.
    expect(
      fireTimes(oscillation('roll', { hz: 3, amplitude: 440, halfCycles: 6, crosstalk: 0.5 })),
    ).toEqual([])
  })

  it('ignores a nod around the horizontal axis (x)', () => {
    expect(
      fireTimes(oscillation('pitch', { hz: 3, amplitude: 400, halfCycles: 6, crosstalk: 0.3 })),
    ).toEqual([])
  })

  it('cools down after a flip, then fires again on the next shake', () => {
    const first = oscillation('yaw', { hz: 3, amplitude: 400, halfCycles: 9 })
    const second = oscillation('yaw', { hz: 3, amplitude: 400, halfCycles: 3 }, 2000)
    const between = sampled(2000 - first.length * STEP, () => ({}), first.length * STEP)
    const times = fireTimes([...first, ...between, ...second])
    expect(times).toHaveLength(2)
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1000)
  })

  it('reset drops a partial shake', () => {
    const detector = createShakeDetector()
    const shake = oscillation('yaw', { hz: 3, amplitude: 400, halfCycles: 3 })
    const fired: boolean[] = []
    shake.forEach((sample, index) => {
      if (index === Math.floor(shake.length * 0.6)) detector.reset()
      fired.push(detector.push(sample))
    })
    sampled(200, () => ({}), shake.at(-1)!.t + STEP).forEach((s) => fired.push(detector.push(s)))
    expect(fired).not.toContain(true)
  })

  it('resets across a sensor pause', () => {
    const swings = oscillation('yaw', { hz: 3, amplitude: 400, halfCycles: 2 })
    const late = oscillation('yaw', { hz: 3, amplitude: 400, halfCycles: 1 }, swings.at(-1)!.t + 400)
    expect(fireTimes([...swings, ...late])).toEqual([])
  })
})

describe('shakeSampleFromRotationRate', () => {
  const rate = { alpha: 1, beta: 2, gamma: 3 }

  it('uses device y (beta) as the shake axis in portrait', () => {
    expect(shakeSampleFromRotationRate(rate, 5, 0)).toEqual({ t: 5, yaw: 2, pitch: 1, roll: 3 })
    expect(shakeSampleFromRotationRate(rate, 5, 180)).toMatchObject({ yaw: 2 })
  })

  it('uses device x (alpha) as the shake axis in landscape', () => {
    expect(shakeSampleFromRotationRate(rate, 5, 90)).toEqual({ t: 5, yaw: 1, pitch: 2, roll: 3 })
    expect(shakeSampleFromRotationRate(rate, 5, 270)).toMatchObject({ yaw: 1 })
    expect(shakeSampleFromRotationRate(rate, 5, -90)).toMatchObject({ yaw: 1 })
  })

  it('returns null without gyroscope data', () => {
    expect(shakeSampleFromRotationRate({ alpha: null, beta: null, gamma: null }, 0, 0)).toBeNull()
  })
})
