import type { Handle } from 'remix/ui'
import { on } from 'remix/ui'
import {
  backfillTakeAnalyses,
  buildDiagnosticsExport,
  clearTakeReports,
  listTakeReports,
} from '../lib/capture-diagnostics'
import { isReportingHostname, sendRecordingReport } from '../lib/error-reporting'
import { shareOrDownload } from '../lib/media'
import {
  describeReason,
  summarizeTakeReports,
  type DropReason,
  type TakeReport,
  type TakeReportSummary,
} from '../lib/take-report'

/** Chrome's Web Share allowlist has no .json — the file is JSON either way. */
const SHARE_FILENAME = 'kody-video-recording-report.txt'
const SEND_FILENAME = 'kody-video-recording-report.json'
const RECENT_TAKES_SHOWN = 12

function formatWhen(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function topReason(summary: TakeReportSummary): DropReason | null {
  let best: DropReason | null = null
  for (const [reason, count] of Object.entries(summary.reasons) as Array<[DropReason, number]>) {
    if (best === null || count > (summary.reasons[best] ?? 0)) best = reason
  }
  return best
}

export function summarySentence(summary: TakeReportSummary): string {
  const since = summary.firstAt ? ` since ${formatWhen(summary.firstAt)}` : ''
  const parts = [
    `${summary.takes} ${summary.takes === 1 ? 'take' : 'takes'}${since}: ${summary.smooth} smooth, ${summary.minor} with a small hiccup, ${summary.choppy} choppy.`,
  ]
  if (summary.expectedFrames > 0) {
    const percent = ((summary.droppedFrames / summary.expectedFrames) * 100).toFixed(1)
    parts.push(
      `${summary.droppedFrames} of ${summary.expectedFrames} frames missing (${percent}%), median ${summary.medianFps} fps.`,
    )
  }
  const reason = topReason(summary)
  if (reason) parts.push(`Most common cause: ${describeReason(reason).toLowerCase()}.`)
  return parts.join(' ')
}

export function takeLine(report: TakeReport): string {
  const bits = [formatWhen(report.recordedAt), `${(report.holdMs / 1000).toFixed(1)}s`]
  const cadence = report.cadence
  if (cadence) {
    bits.push(`${cadence.fps} fps`)
    bits.push(
      cadence.droppedFrames > 0
        ? `${cadence.droppedFrames}/${cadence.expectedFrames} frames missing (worst gap ${cadence.maxGapMs} ms)`
        : 'no frames missing',
    )
  } else if (report.outcome !== 'saved') {
    bits.push(report.outcome === 'empty' ? 'recorded nothing' : 'save failed')
  } else {
    bits.push(report.analysisError ? 'could not analyze' : 'analyzing…')
  }
  const reasons = report.reasons.map((reason) => describeReason(reason).toLowerCase())
  return `${bits.join(' · ')}${reasons.length > 0 ? ` — ${reasons.join('; ')}` : ''}`
}

/**
 * About → Recording health: the on-device take reports, summarized, with
 * explicit ways to get them off the phone (share, copy, send). Nothing
 * leaves the device without one of those taps.
 */
export function RecordingHealthPanel(handle: Handle) {
  let reports: TakeReport[] | null = null
  let busy = false
  let confirmingClear = false
  let status: string | null = null

  const load = async () => {
    reports = await listTakeReports()
    if (!handle.signal.aborted) void handle.update()
  }
  void (async () => {
    try {
      await load()
      // Takes whose analysis never ran (tab closed right after recording).
      if ((await backfillTakeAnalyses()) > 0) await load()
    } catch {
      reports = []
      if (!handle.signal.aborted) void handle.update()
    }
  })()

  const exportJson = () => JSON.stringify(buildDiagnosticsExport(reports ?? []), null, 2)

  const run = (action: () => Promise<string>) => {
    if (busy) return
    busy = true
    status = null
    void handle.update()
    void action()
      .then((message) => {
        status = message
      })
      .catch((error: unknown) => {
        status = error instanceof Error ? error.message : 'Something went wrong — try again.'
      })
      .finally(() => {
        busy = false
        if (!handle.signal.aborted) void handle.update()
      })
  }

  const onShare = () =>
    run(async () => {
      // Share must start inside the tap (transient activation): build the
      // file synchronously, no awaits before the share call.
      const outcome = await shareOrDownload(
        new Blob([exportJson()], { type: 'text/plain' }),
        SHARE_FILENAME,
      )
      if (outcome === 'cancelled') return 'Share cancelled.'
      return outcome === 'shared' ? 'Report shared.' : 'Report downloaded.'
    })

  const onCopy = () =>
    run(async () => {
      await navigator.clipboard.writeText(exportJson())
      return 'Report copied to the clipboard.'
    })

  const onSend = () =>
    run(async () => {
      const exported = buildDiagnosticsExport(reports ?? [])
      const sent = await sendRecordingReport({
        summary: { ...exported.summary, build: exported.build },
        json: JSON.stringify(exported),
        filename: SEND_FILENAME,
      })
      return sent
        ? 'Sent to the Kody Video team — thank you.'
        : "Couldn't send right now — use Share instead."
    })

  const onClear = () => {
    if (!confirmingClear) {
      confirmingClear = true
      void handle.update()
      return
    }
    confirmingClear = false
    run(async () => {
      await clearTakeReports()
      await load()
      return 'Recording reports cleared.'
    })
  }

  return () => {
    const list = reports
    const summary = list ? summarizeTakeReports(list) : null
    return (
      <section className="about-section" id="recording-health">
        <h2>Recording health</h2>
        <p>
          Each take keeps a small report of how smoothly it recorded — frame timings and counters
          from the saved file, never video, audio, location, or names. It stays on this device
          unless you share or send it.
        </p>
        {list === null ? (
          <p>Loading…</p>
        ) : list.length === 0 || !summary ? (
          <p>No takes recorded on this device yet.</p>
        ) : (
          <>
            <p className="recording-health-summary">{summarySentence(summary)}</p>
            <ul className="recording-health-takes" aria-label="Recent takes">
              {list.slice(0, RECENT_TAKES_SHOWN).map((report) => (
                <li key={report.id} className={`is-${report.verdict}`}>
                  {takeLine(report)}
                </li>
              ))}
            </ul>
            <div className="about-import-row">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                mix={on('click', onShare)}
              >
                Share report
              </button>
              <button
                type="button"
                className="link-button"
                disabled={busy}
                mix={on('click', onCopy)}
              >
                Copy
              </button>
              {isReportingHostname() ? (
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  mix={on('click', onSend)}
                >
                  Send to Kody Video
                </button>
              ) : null}
              <button
                type="button"
                className="link-button"
                disabled={busy}
                mix={on('click', onClear)}
              >
                {confirmingClear ? 'Tap again to clear' : 'Clear'}
              </button>
            </div>
          </>
        )}
        {status ? (
          <p role="status" aria-live="polite">
            {status}
          </p>
        ) : null}
      </section>
    )
  }
}
