import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { COMMIT_SHA } from './build-info'
import { runWhenCaptureIdle } from './capture-activity'
import { getClip } from './storage'
import { readTakeTimestamps } from './take-cadence'
import {
  applyTakeAnalysis,
  summarizeTakeReports,
  TAKE_REPORT_VERSION,
  type TakeReport,
  type TakeReportSummary,
} from './take-report'

/**
 * On-device store for take reports — a separate IndexedDB database so the
 * clips schema (and backups) never carry diagnostics. Best-effort by
 * design: a diagnostics failure must never touch recording or saving.
 */

const DB_NAME = 'kody-video-diagnostics'
const DB_VERSION = 1
/** Newest reports kept (~1KB each). */
export const MAX_TAKE_REPORTS = 300

interface DiagnosticsDB extends DBSchema {
  takes: {
    key: string
    value: TakeReport
    indexes: { 'by-recorded': number }
  }
}

let dbPromise: Promise<IDBPDatabase<DiagnosticsDB>> | null = null

function getDb(): Promise<IDBPDatabase<DiagnosticsDB>> {
  dbPromise ??= openDB<DiagnosticsDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const store = db.createObjectStore('takes', { keyPath: 'id' })
      store.createIndex('by-recorded', 'recordedAt')
    },
  }).catch((error: unknown) => {
    dbPromise = null
    throw error
  })
  return dbPromise
}

export async function saveTakeReport(report: TakeReport): Promise<void> {
  const db = await getDb()
  await db.put('takes', report)
  const count = await db.count('takes')
  if (count <= MAX_TAKE_REPORTS) return
  const tx = db.transaction('takes', 'readwrite')
  let excess = count - MAX_TAKE_REPORTS
  let cursor = await tx.store.index('by-recorded').openCursor()
  while (cursor && excess > 0) {
    await cursor.delete()
    excess -= 1
    cursor = await cursor.continue()
  }
  await tx.done
}

/** Newest first. */
export async function listTakeReports(): Promise<TakeReport[]> {
  const db = await getDb()
  const reports = await db.getAllFromIndex('takes', 'by-recorded')
  return reports.filter((report) => report.v === TAKE_REPORT_VERSION).reverse()
}

export async function clearTakeReports(): Promise<void> {
  const db = await getDb()
  await db.clear('takes')
}

export async function __resetDiagnosticsDbForTests(): Promise<void> {
  const open = dbPromise
  dbPromise = null
  if (open) (await open.catch(() => null))?.close()
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

function whenBrowserIdle(timeoutMs = 2000): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => resolve(), { timeout: timeoutMs })
    } else {
      window.setTimeout(resolve, 500)
    }
  })
}

export async function analyzeTakeReport(
  report: TakeReport,
  blob: Blob,
  window: { startMs: number; endMs: number },
): Promise<TakeReport> {
  const startedAt = performance.now()
  try {
    const stamps = await readTakeTimestamps(blob)
    return applyTakeAnalysis(report, stamps, window, performance.now() - startedAt)
  } catch (error) {
    return {
      ...report,
      verdict: 'unknown',
      analysisError: (error instanceof Error ? error.message : String(error)).slice(0, 200),
    }
  }
}

/**
 * Persist a finished take's report now (so a killed tab still keeps its
 * live signals), then read the file's frame timings once the browser is
 * idle and no take is recording, and update the report.
 */
export function recordTakeReport(
  report: TakeReport,
  media?: { blob: Blob; window: { startMs: number; endMs: number } },
): Promise<void> {
  return (async () => {
    await saveTakeReport(report)
    if (!media) return
    await whenBrowserIdle()
    const analyzed = await runWhenCaptureIdle('take-analysis', () =>
      analyzeTakeReport(report, media.blob, media.window),
    )
    await saveTakeReport(analyzed)
  })().catch(() => undefined)
}

/** Analyze saved takes whose analysis never ran (tab closed right after
 * the take). Reads the clip from storage; skipped for deleted clips. */
export async function backfillTakeAnalyses(): Promise<number> {
  let updated = 0
  for (const report of await listTakeReports()) {
    if (report.cadence || report.analysisError || !report.clipId) continue
    const clip = await getClip(report.clipId).catch(() => undefined)
    if (!clip) continue
    const analyzed = await runWhenCaptureIdle('take-analysis', () =>
      analyzeTakeReport(report, clip.blob, { startMs: clip.trimStartMs, endMs: clip.trimEndMs }),
    )
    await saveTakeReport(analyzed)
    updated += 1
  }
  return updated
}

export interface DiagnosticsExport {
  kind: 'kody-video-recording-report'
  version: typeof TAKE_REPORT_VERSION
  generatedAt: string
  build: string
  summary: TakeReportSummary
  takes: TakeReport[]
}

export function buildDiagnosticsExport(reports: TakeReport[]): DiagnosticsExport {
  return {
    kind: 'kody-video-recording-report',
    version: TAKE_REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    build: COMMIT_SHA,
    summary: summarizeTakeReports(reports),
    takes: reports,
  }
}
