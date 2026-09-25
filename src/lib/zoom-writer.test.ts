import { describe, expect, it } from 'vitest'
import { createZoomWriter } from './zoom-writer'

/** Manual clock + timer queue so spacing is asserted without real waits. */
function harness(minIntervalMs = 33) {
  let clock = 0
  let nextHandle = 1
  const timers = new Map<number, { at: number; run: () => void }>()
  const writes: number[] = []
  const writeTimes: number[] = []
  const settles: Array<(ok: boolean) => void> = []
  const writer = createZoomWriter(
    (value) => {
      writes.push(value)
      writeTimes.push(clock)
      return new Promise<void>((resolve, reject) => {
        settles.push((ok) => (ok ? resolve() : reject(new Error('camera busy'))))
      })
    },
    {
      minIntervalMs,
      now: () => clock,
      schedule: (run, delayMs) => {
        const handle = nextHandle++
        timers.set(handle, { at: clock + delayMs, run })
        return handle
      },
      cancel: (handle) => {
        timers.delete(handle)
      },
    },
  )
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  return {
    writer,
    writes,
    writeTimes,
    pendingTimers: () => timers.size,
    async settle(ok = true) {
      settles.shift()?.(ok)
      await flush()
    },
    async advance(ms: number) {
      clock += ms
      for (const [handle, timer] of [...timers]) {
        if (timer.at <= clock) {
          timers.delete(handle)
          timer.run()
        }
      }
      await flush()
    },
  }
}

describe('createZoomWriter', () => {
  it('applies the first value immediately', () => {
    const h = harness()
    h.writer.set(1.5)
    expect(h.writes).toEqual([1.5])
  })

  it('collapses a drag burst into the latest value, one write in flight', async () => {
    const h = harness()
    h.writer.set(1.1)
    // 120Hz pointermove while the first write is still in flight.
    for (const value of [1.2, 1.3, 1.4, 1.5, 1.6]) h.writer.set(value)
    expect(h.writes).toEqual([1.1])
    await h.settle()
    // Settled before a frame elapsed: the next write waits for spacing.
    expect(h.writes).toEqual([1.1])
    await h.advance(33)
    expect(h.writes).toEqual([1.1, 1.6])
  })

  it('spaces writes at least one frame apart even when the camera acks instantly', async () => {
    const h = harness(33)
    for (let i = 0; i < 12; i += 1) {
      h.writer.set(1 + i / 10)
      await h.settle()
      await h.advance(8)
    }
    // ~96ms of 125Hz input → at most one write per 33ms frame.
    expect(h.writes.length).toBeLessThanOrEqual(4)
    for (let i = 1; i < h.writeTimes.length; i += 1) {
      expect(h.writeTimes[i]! - h.writeTimes[i - 1]!).toBeGreaterThanOrEqual(33)
    }
    // The final value always lands.
    await h.advance(40)
    expect(h.writes.at(-1)).toBeCloseTo(2.1)
  })

  it('skips a value equal to the last write', async () => {
    const h = harness()
    h.writer.set(2)
    await h.settle()
    await h.advance(50)
    h.writer.set(2)
    expect(h.writes).toEqual([2])
  })

  it('keeps writing after a rejected constraint', async () => {
    const h = harness()
    h.writer.set(1.2)
    h.writer.set(1.4)
    await h.settle(false)
    await h.advance(33)
    expect(h.writes).toEqual([1.2, 1.4])
  })

  it('retries a value the camera rejected when it is requested again', async () => {
    const h = harness()
    h.writer.set(2)
    await h.settle(false)
    await h.advance(50)
    h.writer.set(2)
    expect(h.writes).toEqual([2, 2])
  })

  it('drops pending values on dispose', async () => {
    const h = harness()
    h.writer.set(1.2)
    await h.settle()
    h.writer.set(1.8)
    expect(h.pendingTimers()).toBe(1)
    h.writer.dispose()
    expect(h.pendingTimers()).toBe(0)
    await h.advance(100)
    expect(h.writes).toEqual([1.2])
  })
})
