import { describe, expect, it } from 'vitest'
import {
  EXPORT_FRAME_INTERVAL_SEC,
  planExportFrame,
  type ExportFrameClock,
} from './export-frame-clock'

function apply(
  clock: ExportFrameClock,
  tsSec: number,
  options?: { force?: boolean },
): { held: number; dropped: boolean; emitTsSec: number | null } {
  const plan = planExportFrame(clock, tsSec, options)
  if (!plan) return { held: 0, dropped: true, emitTsSec: null }
  clock.lastVideoTsSec = plan.emitTsSec
  clock.nextFrameTsSec = plan.nextFrameTsSec
  return { held: plan.holdTicks, dropped: false, emitTsSec: plan.emitTsSec }
}

describe('planExportFrame', () => {
  it('keeps jittery 30fps timestamps from the Pixel debug clip', () => {
    const clock: ExportFrameClock = { nextFrameTsSec: 0, lastVideoTsSec: -1 }
    // First 15 PTS values from raw-video-from-zip-download.mp4
    const raw = [
      0.0, 0.0331, 0.0682, 0.0961, 0.2667, 0.3008, 0.3355, 0.362, 0.3967, 0.4295, 0.4613,
      0.5026, 0.5295, 0.5591, 0.5945,
    ]
    const dropped: number[] = []
    let holds = 0
    raw.forEach((ts, i) => {
      const result = apply(clock, ts, { force: i === 0 })
      if (result.dropped) dropped.push(ts)
      holds += result.held
    })
    expect(dropped).toEqual([])
    // The 171ms hole at 0.096→0.267 becomes held ticks, not a skip.
    expect(holds).toBeGreaterThanOrEqual(4)
  })

  it('drops 60fps extras and keeps the 30fps grid', () => {
    const clock: ExportFrameClock = { nextFrameTsSec: 0, lastVideoTsSec: -1 }
    expect(apply(clock, 0, { force: true }).dropped).toBe(false)
    expect(apply(clock, EXPORT_FRAME_INTERVAL_SEC / 2).dropped).toBe(true)
    expect(apply(clock, EXPORT_FRAME_INTERVAL_SEC).dropped).toBe(false)
  })

  it('does not drop a frame 21ms after the previous (jittery 30fps)', () => {
    const clock: ExportFrameClock = { nextFrameTsSec: 0, lastVideoTsSec: -1 }
    apply(clock, 0, { force: true })
    const early = apply(clock, 0.021)
    expect(early.dropped).toBe(false)
  })
})
