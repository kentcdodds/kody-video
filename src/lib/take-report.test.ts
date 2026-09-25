import { describe, expect, it } from 'vitest'
import { analyzeFrameCadence } from './take-cadence'
import type { LiveTakeSignals } from './take-probe'
import {
  applyTakeAnalysis,
  classifyTake,
  describeReason,
  draftTakeReport,
  summarizeTakeReports,
  verdictFor,
  type TakeReport,
  type TakeStart,
} from './take-report'

function live(overrides: Partial<LiveTakeSignals> = {}): LiveTakeSignals {
  return {
    durationMs: 4000,
    mainThread: {
      maxLagMs: 0,
      lagHistogram: { '50-100': 0, '100-150': 0, '150-250': 0, '250-500': 0, '500+': 0 },
      longTasks: { supported: true, count: 0, totalMs: 0, maxMs: 0 },
      stalls: [],
    },
    hidden: [],
    zoom: { requested: 0, applied: 0, windows: [] },
    backgroundWork: [],
    ...overrides,
  }
}

const start: TakeStart = {
  recordedAt: 1_790_000_000_000,
  mode: 'hold',
  quality: 'high',
  mimeType: 'video/mp4',
  camera: { width: 1080, height: 1920, frameRate: 30, facingMode: 'environment' },
  env: {
    os: 'android',
    browser: 'chrome',
    installed: true,
    cameraOpenMs: 90_000,
    takeIndex: 3,
    previousSaveInFlight: false,
    idleEncoder: { sessions: 40, encodeMs: 60_000 },
  },
}

function draft(signals = live(), sessionMs = 4400): TakeReport {
  return draftTakeReport({
    sessionId: 's1',
    start,
    live: signals,
    outcome: 'saved',
    clipId: 'clip-1',
    saveMs: 180,
    recording: {
      blob: new Blob([new Uint8Array(5_500_000)]),
      mimeType: 'video/mp4',
      facts: {
        warmAgeMs: 900,
        sessionMs,
        graceMs: 205,
        flushMs: 40,
        measureMs: 30,
        videoBitsPerSecond: 10_000_000,
        trackFrames: { total: 132, delivered: 132, discarded: 0 },
      },
    },
  })
}

/** 30fps timestamps over `ms` with frames [from, to] removed. */
function stampsWithHole(ms: number, from = -1, to = -1): number[] {
  const out: number[] = []
  for (let i = 0; i * (1000 / 30) < ms; i += 1) {
    if (i < from || i > to) out.push(i / 30)
  }
  return out
}

describe('draftTakeReport', () => {
  it('carries encoder facts, bitrate, and no cadence yet', () => {
    const report = draft()
    expect(report.v).toBe(1)
    expect(report.clipId).toBe('clip-1')
    expect(report.holdMs).toBe(4000)
    expect(report.encoder?.kbps).toBe(10_000)
    expect(report.cadence).toBeUndefined()
    expect(report.verdict).toBe('unknown')
  })

  it('stores no media, location, or names', () => {
    const json = JSON.stringify(draft())
    expect(json).not.toMatch(/lat|lng|name|blob:/i)
  })
})

describe('verdictFor', () => {
  it('grades by stalls, loss ratio, and fps', () => {
    expect(verdictFor(analyzeFrameCadence(stampsWithHole(4000), { startMs: 0, endMs: 4000 }))).toBe(
      'smooth',
    )
    expect(
      verdictFor(analyzeFrameCadence(stampsWithHole(4000, 40, 40), { startMs: 0, endMs: 4000 })),
    ).toBe('smooth')
    const twoSingles = stampsWithHole(4000, 40, 40).filter((_, i) => i !== 80)
    expect(verdictFor(analyzeFrameCadence(twoSingles, { startMs: 0, endMs: 4000 }))).toBe('minor')
    expect(
      verdictFor(analyzeFrameCadence(stampsWithHole(4000, 40, 45), { startMs: 0, endMs: 4000 })),
    ).toBe('choppy')
  })
})

describe('classifyTake', () => {
  const window = { startMs: 0, endMs: 4000 }
  const stamps = (video: number[]) => ({ videoSec: video, audio: [], videoCodec: 'avc1.640028' })

  it('attributes a gap to an overlapping main-thread stall', () => {
    const report = applyTakeAnalysis(
      draft(
        live({
          mainThread: {
            ...live().mainThread,
            maxLagMs: 260,
            stalls: [{ atMs: 1950, durationMs: 260 }],
          },
        }),
      ),
      stamps(stampsWithHole(4000, 60, 66)),
      window,
      12,
    )
    expect(report.verdict).toBe('choppy')
    expect(report.gaps?.[0]?.reason).toBe('main-thread')
    expect(report.reasons).toContain('main-thread')
    expect(report.reasons).not.toContain('unexplained')
  })

  it('attributes a gap during a zoom drag to zoom', () => {
    const report = applyTakeAnalysis(
      draft(live({ zoom: { requested: 90, applied: 30, windows: [{ atMs: 1500, durationMs: 1200 }] } })),
      stamps(stampsWithHole(4000, 60, 66)),
      window,
      12,
    )
    expect(report.gaps?.[0]?.reason).toBe('zoom')
  })

  it('flags a camera delivering well under 30fps', () => {
    const fifteen = Array.from({ length: 60 }, (_, i) => i / 15)
    const report = applyTakeAnalysis(draft(), stamps(fifteen), window, 12)
    expect(report.verdict).toBe('choppy')
    expect(report.reasons).toContain('camera-rate')
  })

  it('flags frames the camera produced that never reached the recorder', () => {
    // The probe's main-thread jank take: 131 produced, 104 delivered.
    const base = draft()
    const report = applyTakeAnalysis(
      {
        ...base,
        encoder: { ...base.encoder!, trackFrames: { total: 131, delivered: 104, discarded: 0 } },
      },
      stamps(stampsWithHole(4000, 60, 66)),
      window,
      12,
    )
    expect(report.reasons).toContain('delivery-loss')
  })

  it('flags frames that reached the encoder but not the file', () => {
    const report = applyTakeAnalysis(draft(), stamps(stampsWithHole(4000, 60, 70)), window, 12)
    // 132 delivered by the track vs 109 frames in the file.
    expect(report.reasons).toContain('encoder-loss')
  })

  it('calls an unmatched gap unexplained', () => {
    const report = applyTakeAnalysis(
      { ...draft(), encoder: undefined },
      stamps(stampsWithHole(4000, 60, 66)),
      window,
      12,
    )
    expect(report.reasons).toEqual(['unexplained'])
  })

  it('leaves smooth takes without reasons', () => {
    const report = classifyTake(applyTakeAnalysis(draft(), stamps(stampsWithHole(4000)), window, 5))
    expect(report).toEqual({ verdict: 'smooth', reasons: [], gaps: [] })
  })
})

describe('summarizeTakeReports', () => {
  it('rolls up verdicts, loss, and reasons', () => {
    const window = { startMs: 0, endMs: 4000 }
    const smooth = applyTakeAnalysis(
      draft(),
      { videoSec: stampsWithHole(4000), audio: [], videoCodec: null },
      window,
      5,
    )
    const choppy = applyTakeAnalysis(
      draft(live({ hidden: [{ atMs: 1900, durationMs: 400 }] })),
      { videoSec: stampsWithHole(4000, 58, 70), audio: [], videoCodec: null },
      window,
      5,
    )
    const pending = draft()
    const summary = summarizeTakeReports([smooth, choppy, pending])
    expect(summary).toMatchObject({ takes: 3, analyzed: 2, smooth: 1, choppy: 1 })
    expect(summary.droppedFrames).toBe(13)
    expect(summary.expectedFrames).toBe(240)
    expect(summary.reasons.backgrounded).toBe(1)
    expect(describeReason('backgrounded')).toMatch(/hidden/i)
  })
})
