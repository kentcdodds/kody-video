import { activeBackgroundWork } from './capture-activity'

/**
 * Live signals for one take — with no per-frame work (the recorder's own
 * smoothness is the point). A 100ms timer measures event-loop lag,
 * `longtask` entries add precise stalls where supported (Chromium),
 * visibility and preview playback counters are read at the edges, and
 * zoom drags / background work are kept as time windows so the saved
 * file's frame gaps can be lined up with what happened (take-report.ts).
 * Counters and timings only — never pixels or audio.
 */

/** Chromium's MediaRecorder started losing recorded frames once the main
 * thread stalled for somewhere between 150ms and 250ms (see
 * docs/recording-smoothness.md) — the report flags stalls from here up. */
export const RISKY_STALL_MS = 150

const LAG_INTERVAL_MS = 100
/** Timer lateness below this is ordinary scheduling noise. */
const LAG_NOISE_MS = 50
const MAX_WINDOWS = 16
/** Zoom writes closer together than this belong to the same drag. */
const ZOOM_WINDOW_JOIN_MS = 300

export const LAG_BUCKETS = ['50-100', '100-150', '150-250', '250-500', '500+'] as const
export type LagBucket = (typeof LAG_BUCKETS)[number]

export interface TimeWindow {
  /** Offset from the take's start, ms. */
  atMs: number
  durationMs: number
}

export interface LiveTakeSignals {
  durationMs: number
  mainThread: {
    /** Worst timer lateness (≈ longest main-thread stall). */
    maxLagMs: number
    lagHistogram: Record<LagBucket, number>
    longTasks: { supported: boolean; count: number; totalMs: number; maxMs: number }
    /** Stalls ≥ RISKY_STALL_MS (from lag and long tasks), capped. */
    stalls: TimeWindow[]
  }
  /** Time the page spent hidden mid-take (backgrounded / screen off). */
  hidden: TimeWindow[]
  zoom: { requested: number; applied: number; windows: TimeWindow[] }
  /** Viewfinder element counters over the take (what the user watched). */
  preview?: { frames: number; dropped: number }
  /** Optional background work seen running during the take. */
  backgroundWork: string[]
}

export interface TakeProbe {
  /** Drag-to-zoom moved the lens (called per applied zoom request). */
  noteZoom(): void
  finish(): LiveTakeSignals
}

interface ProbeOptions {
  preview: HTMLVideoElement | null
  zoomCounts: () => { requested: number; applied: number }
  now?: () => number
}

function emptyLagHistogram(): Record<LagBucket, number> {
  return { '50-100': 0, '100-150': 0, '150-250': 0, '250-500': 0, '500+': 0 }
}

export function lagBucket(lateMs: number): LagBucket {
  if (lateMs < 100) return '50-100'
  if (lateMs < 150) return '100-150'
  if (lateMs < 250) return '150-250'
  if (lateMs < 500) return '250-500'
  return '500+'
}

function readPlayback(video: HTMLVideoElement | null): { total: number; dropped: number } | null {
  try {
    const quality = video?.getVideoPlaybackQuality?.()
    if (!quality) return null
    return { total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames }
  } catch {
    return null
  }
}

function supportsLongTasks(): boolean {
  try {
    return (
      typeof PerformanceObserver !== 'undefined' &&
      PerformanceObserver.supportedEntryTypes?.includes('longtask') === true
    )
  } catch {
    return false
  }
}

/** Append an in-order event to a window list, joining touching windows. */
function pushWindow(list: TimeWindow[], atMs: number, durationMs: number, joinMs = 0): void {
  const last = list.at(-1)
  if (last && atMs <= last.atMs + last.durationMs + joinMs) {
    last.durationMs = Math.max(last.durationMs, atMs + durationMs - last.atMs)
    return
  }
  if (list.length >= MAX_WINDOWS) return
  list.push({ atMs, durationMs })
}

/** Sort and merge overlapping windows (sources report out of order). */
export function mergeWindows(windows: readonly TimeWindow[]): TimeWindow[] {
  const merged: TimeWindow[] = []
  for (const item of [...windows].sort((a, b) => a.atMs - b.atMs)) {
    pushWindow(merged, item.atMs, item.durationMs)
  }
  return merged
}

export function startTakeProbe(options: ProbeOptions): TakeProbe {
  const now = options.now ?? (() => performance.now())
  const startedAt = now()
  const rel = (at: number) => Math.max(0, Math.round(at - startedAt))

  const lagHistogram = emptyLagHistogram()
  let maxLagMs = 0
  const stalls: TimeWindow[] = []
  const noteStall = (atMs: number, durationMs: number) => {
    if (stalls.length < MAX_WINDOWS * 4) stalls.push({ atMs, durationMs })
  }
  const hidden: TimeWindow[] = []
  const zoomWindows: TimeWindow[] = []
  const background = new Set(activeBackgroundWork())
  const zoomAtStart = options.zoomCounts()
  const previewAtStart = readPlayback(options.preview)

  let expected = startedAt + LAG_INTERVAL_MS
  const lagTimer = window.setInterval(() => {
    const at = now()
    const lateMs = at - expected
    expected = at + LAG_INTERVAL_MS
    for (const label of activeBackgroundWork()) background.add(label)
    // Hidden pages throttle timers — that lateness is not a stall.
    if (document.hidden || lateMs < LAG_NOISE_MS) return
    lagHistogram[lagBucket(lateMs)] += 1
    maxLagMs = Math.max(maxLagMs, lateMs)
    if (lateMs >= RISKY_STALL_MS) noteStall(rel(at - lateMs), Math.round(lateMs))
  }, LAG_INTERVAL_MS)

  const longTasks = { supported: supportsLongTasks(), count: 0, totalMs: 0, maxMs: 0 }
  let observer: PerformanceObserver | null = null
  if (longTasks.supported) {
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.startTime + entry.duration < startedAt) continue
          longTasks.count += 1
          longTasks.totalMs += entry.duration
          longTasks.maxMs = Math.max(longTasks.maxMs, entry.duration)
          if (entry.duration >= RISKY_STALL_MS) {
            noteStall(rel(entry.startTime), Math.round(entry.duration))
          }
        }
      })
      observer.observe({ type: 'longtask' })
    } catch {
      observer = null
    }
  }

  let hiddenSince: number | null = document.hidden ? startedAt : null
  const onVisibility = () => {
    const at = now()
    if (document.hidden) {
      hiddenSince ??= at
      return
    }
    if (hiddenSince !== null) {
      pushWindow(hidden, rel(hiddenSince), Math.round(at - hiddenSince))
      hiddenSince = null
    }
  }
  document.addEventListener('visibilitychange', onVisibility)

  let finished: LiveTakeSignals | null = null

  return {
    noteZoom() {
      if (finished) return
      pushWindow(zoomWindows, rel(now()), 0, ZOOM_WINDOW_JOIN_MS)
    },
    finish() {
      if (finished) return finished
      const endedAt = now()
      window.clearInterval(lagTimer)
      observer?.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      if (hiddenSince !== null) pushWindow(hidden, rel(hiddenSince), Math.round(endedAt - hiddenSince))
      const zoomAtEnd = options.zoomCounts()
      const previewAtEnd = readPlayback(options.preview)
      finished = {
        durationMs: Math.round(endedAt - startedAt),
        mainThread: {
          maxLagMs: Math.round(maxLagMs),
          lagHistogram,
          longTasks: {
            ...longTasks,
            totalMs: Math.round(longTasks.totalMs),
            maxMs: Math.round(longTasks.maxMs),
          },
          stalls: mergeWindows(stalls),
        },
        hidden,
        zoom: {
          requested: Math.max(0, zoomAtEnd.requested - zoomAtStart.requested),
          applied: Math.max(0, zoomAtEnd.applied - zoomAtStart.applied),
          windows: zoomWindows,
        },
        ...(previewAtStart && previewAtEnd
          ? {
              preview: {
                frames: Math.max(0, previewAtEnd.total - previewAtStart.total),
                dropped: Math.max(0, previewAtEnd.dropped - previewAtStart.dropped),
              },
            }
          : {}),
        backgroundWork: [...background],
      }
      return finished
    },
  }
}
