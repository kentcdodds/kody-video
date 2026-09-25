import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetDiagnosticsDbForTests,
  analyzeTakeReport,
  backfillTakeAnalyses,
  buildDiagnosticsExport,
  clearTakeReports,
  CLIP_GONE_ERROR,
  listTakeReports,
  MAX_TAKE_REPORTS,
  recordTakeReport,
  saveTakeReport,
  updateTakeReport,
} from './capture-diagnostics'
import { __resetDbForTests, addClip, createProject } from './storage'
import { makeTestClipBlob } from './testing/make-test-clip'
import { draftTakeReport, type TakeReport } from './take-report'

function report(recordedAt: number, clipId?: string): TakeReport {
  return draftTakeReport({
    sessionId: 'session',
    outcome: 'saved',
    clipId,
    start: {
      recordedAt,
      mode: 'hold',
      quality: 'standard',
      mimeType: 'video/webm',
      camera: {},
      env: {
        os: 'linux',
        browser: 'chrome',
        installed: false,
        cameraOpenMs: 1000,
        takeIndex: 0,
        previousSaveInFlight: false,
        idleEncoder: { sessions: 0, encodeMs: 0 },
      },
    },
    live: {
      durationMs: 1500,
      mainThread: {
        maxLagMs: 0,
        lagHistogram: { '50-100': 0, '100-150': 0, '150-250': 0, '250-500': 0, '500+': 0 },
        longTasks: { supported: false, count: 0, totalMs: 0, maxMs: 0 },
        stalls: [],
      },
      hidden: [],
      zoom: { requested: 0, applied: 0, windows: [] },
      backgroundWork: [],
    },
  })
}

describe('capture diagnostics store', () => {
  beforeEach(async () => {
    await __resetDiagnosticsDbForTests()
    await __resetDbForTests()
  })

  it('lists reports newest first and clears them', async () => {
    await saveTakeReport(report(1000))
    await saveTakeReport(report(3000))
    await saveTakeReport(report(2000))
    expect((await listTakeReports()).map((r) => r.recordedAt)).toEqual([3000, 2000, 1000])
    await clearTakeReports()
    expect(await listTakeReports()).toEqual([])
  })

  it(`keeps only the newest ${MAX_TAKE_REPORTS} reports`, async () => {
    for (let i = 0; i < MAX_TAKE_REPORTS + 3; i += 1) await saveTakeReport(report(i))
    const reports = await listTakeReports()
    expect(reports).toHaveLength(MAX_TAKE_REPORTS)
    expect(reports.at(-1)?.recordedAt).toBe(3)
  })

  it('saves the draft, then fills in the saved clip’s cadence', async () => {
    const project = await createProject('Trip')
    const clip = await addClip({
      projectId: project.id,
      blob: await makeTestClipBlob(1500),
      mimeType: 'video/webm',
      durationMs: 1500,
    })
    await recordTakeReport(report(5000, clip.id))
    const [saved] = await listTakeReports()
    expect(saved?.cadence?.frames).toBeGreaterThan(10)
    expect(saved?.wholeFile?.frames).toBe(saved?.cadence?.frames)
    // The 15fps fixture reads as camera-rate-limited against 30fps.
    expect(saved?.reasons).toContain('camera-rate')
  })

  it('does not resurrect a report cleared while its analysis ran', async () => {
    const draft = report(6000, 'clip-1')
    await saveTakeReport(draft)
    const analyzed = { ...draft, verdict: 'smooth' as const }
    await clearTakeReports()
    await updateTakeReport(analyzed)
    expect(await listTakeReports()).toEqual([])
    // Still-stored reports do get the update.
    await saveTakeReport(draft)
    await updateTakeReport(analyzed)
    expect((await listTakeReports())[0]?.verdict).toBe('smooth')
  })

  it('records an analysis error instead of throwing on a bad file', async () => {
    const analyzed = await analyzeTakeReport(report(1), new Blob(['nope']), {
      startMs: 0,
      endMs: 1000,
    })
    expect(analyzed.verdict).toBe('unknown')
    expect(analyzed.analysisError).toBeTruthy()
  })

  it('backfills analyses that never ran from the saved clip', async () => {
    const project = await createProject('Trip')
    const clip = await addClip({
      projectId: project.id,
      blob: await makeTestClipBlob(1500),
      mimeType: 'video/webm',
      durationMs: 1500,
    })
    await saveTakeReport(report(7000, clip.id))
    await saveTakeReport(report(8000, 'deleted-clip'))
    expect(await backfillTakeAnalyses()).toBe(2)
    const reports = await listTakeReports()
    expect(reports.find((r) => r.clipId === clip.id)?.cadence).toBeDefined()
    // A deleted clip settles instead of staying "analyzing…" forever.
    const gone = reports.find((r) => r.clipId === 'deleted-clip')
    expect(gone?.cadence).toBeUndefined()
    expect(gone?.analysisError).toBe(CLIP_GONE_ERROR)
    expect(await backfillTakeAnalyses()).toBe(0)
  })

  it('exports a self-describing report with a summary', async () => {
    const exported = buildDiagnosticsExport([report(1), report(2)])
    expect(exported.kind).toBe('kody-video-recording-report')
    expect(exported.summary.takes).toBe(2)
    expect(exported.takes).toHaveLength(2)
  })
})
