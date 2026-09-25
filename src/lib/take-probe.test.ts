import { describe, expect, it } from 'vitest'
import { lagBucket, mergeWindows, startTakeProbe } from './take-probe'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function blockMainThread(ms: number): void {
  const until = performance.now() + ms
  while (performance.now() < until) {
    // Simulated heavy synchronous work.
  }
}

describe('lagBucket', () => {
  it('buckets timer lateness', () => {
    expect([60, 120, 200, 300, 900].map(lagBucket)).toEqual([
      '50-100',
      '100-150',
      '150-250',
      '250-500',
      '500+',
    ])
  })
})

describe('mergeWindows', () => {
  it('sorts and merges overlapping windows from both stall sources', () => {
    expect(
      mergeWindows([
        { atMs: 900, durationMs: 200 },
        { atMs: 100, durationMs: 300 },
        { atMs: 250, durationMs: 100 },
      ]),
    ).toEqual([
      { atMs: 100, durationMs: 300 },
      { atMs: 900, durationMs: 200 },
    ])
  })
})

describe('startTakeProbe', () => {
  it('records a main-thread stall during the take', async () => {
    let zoom = { requested: 0, applied: 0 }
    const probe = startTakeProbe({ preview: null, zoomCounts: () => zoom })
    await wait(150)
    blockMainThread(260)
    await wait(250)
    zoom = { requested: 12, applied: 4 }
    const signals = probe.finish()
    expect(signals.durationMs).toBeGreaterThanOrEqual(600)
    expect(signals.mainThread.maxLagMs).toBeGreaterThanOrEqual(150)
    expect(signals.mainThread.stalls.length).toBeGreaterThanOrEqual(1)
    const stall = signals.mainThread.stalls[0]!
    expect(stall.durationMs).toBeGreaterThanOrEqual(150)
    // The stall began ~150ms into the take (timer + long-task sources).
    expect(stall.atMs).toBeGreaterThan(50)
    expect(stall.atMs).toBeLessThan(400)
    expect(signals.zoom).toMatchObject({ requested: 12, applied: 4 })
  })

  it('joins zoom notes from one drag into a single window', async () => {
    const probe = startTakeProbe({ preview: null, zoomCounts: () => ({ requested: 0, applied: 0 }) })
    probe.noteZoom()
    await wait(60)
    probe.noteZoom()
    await wait(60)
    probe.noteZoom()
    const signals = probe.finish()
    expect(signals.zoom.windows).toHaveLength(1)
    expect(signals.zoom.windows[0]!.durationMs).toBeGreaterThanOrEqual(100)
  })

  it('stays quiet on an idle take and is idempotent', async () => {
    const probe = startTakeProbe({ preview: null, zoomCounts: () => ({ requested: 0, applied: 0 }) })
    await wait(250)
    const first = probe.finish()
    expect(first.mainThread.stalls).toEqual([])
    expect(first.hidden).toEqual([])
    expect(probe.finish()).toBe(first)
  })
})
