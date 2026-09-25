import type { RecordingSessionFacts } from './recorder'
import {
  analyzeAudioContinuity,
  analyzeFrameCadence,
  type AudioContinuity,
  type FrameCadence,
  type TakeTimestamps,
} from './take-cadence'
import type { LiveTakeSignals, TimeWindow } from './take-probe'
import { VIDEO_FPS } from './video-quality'

/**
 * One take's recording-health report: what the saved file contains
 * (frame cadence), what was happening while it recorded (live signals),
 * and the environment. Stored on the device only (capture-diagnostics.ts);
 * it leaves the device only when the user shares or sends it. Timings and
 * counters — never media, location, or project names.
 */

export const TAKE_REPORT_VERSION = 1

export type TakeVerdict = 'smooth' | 'minor' | 'choppy' | 'unknown'

/** Why frames went missing. A take can carry several. */
export type DropReason =
  /** The camera itself delivered < ~25fps (low-light exposure, thermal cap). */
  | 'camera-rate'
  /** Chromium discarded frames before they reached the recorder. */
  | 'frames-discarded'
  /** Frames reached MediaRecorder but are missing from the file. */
  | 'encoder-loss'
  /** A gap lines up with a main-thread stall ≥ RISKY_STALL_MS. */
  | 'main-thread'
  /** A gap lines up with a drag-to-zoom burst. */
  | 'zoom'
  /** The app was hidden (backgrounded / screen off) mid-take. */
  | 'backgrounded'
  /** Optional background work (hydrate, analysis) overlapped the take. */
  | 'background-work'
  /** Frozen/missing head: the encoder started at the press. */
  | 'cold-start'
  | 'unexplained'

export type TakeOutcome = 'saved' | 'empty' | 'save-failed'

export interface TakeEnvironment {
  os: string
  browser: string
  installed: boolean
  cores?: number
  memoryGb?: number
  battery?: { level: number; charging: boolean }
  /** Compute Pressure API CPU state where supported (a thermal proxy). */
  pressure?: string
  /** How long the camera screen had been open when the take started. */
  cameraOpenMs: number
  /** Takes recorded on this camera screen before this one. */
  takeIndex: number
  /** The previous take was still saving when this one started. */
  previousSaveInFlight: boolean
  /** Encoders run while idle so far this camera session (heat/battery). */
  idleEncoder: { sessions: number; encodeMs: number }
}

export interface TakeCamera {
  width?: number
  height?: number
  frameRate?: number
  facingMode?: string
  zoom?: number
}

export interface TakeReport {
  v: typeof TAKE_REPORT_VERSION
  id: string
  /** Epoch ms at the press. */
  recordedAt: number
  /** Random per camera-screen mount — groups takes of one session. */
  sessionId: string
  /** Local clip id (random) — lets a report be re-analyzed later. */
  clipId?: string
  mode: 'hold' | 'hands-free'
  outcome: TakeOutcome
  holdMs: number
  quality: string
  mimeType: string
  camera: TakeCamera
  encoder?: RecordingSessionFacts & { blobBytes: number; kbps: number }
  /** appendRecording: copy blob + IndexedDB write + thumbs. */
  saveMs?: number
  live: LiveTakeSignals
  env: TakeEnvironment
  /** Cadence of the KEPT range (what ends up in the memory). */
  cadence?: FrameCadence
  wholeFile?: { frames: number; fps: number; droppedFrames: number; firstVideoMs: number }
  audio?: AudioContinuity
  videoCodec?: string | null
  analysisMs?: number
  analysisError?: string
  /** Gaps from `cadence.worstGaps` with the reason each lines up with. */
  gaps?: Array<{ atMs: number; gapMs: number; missing: number; reason: DropReason }>
  verdict: TakeVerdict
  reasons: DropReason[]
}

/** What the record screen knows at the press. */
export interface TakeStart {
  recordedAt: number
  mode: TakeReport['mode']
  quality: string
  mimeType: string
  camera: TakeCamera
  env: TakeEnvironment
}

function reportId(recordedAt: number): string {
  return `${recordedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** A report with live signals and encoder facts; cadence comes later. */
export function draftTakeReport(input: {
  sessionId: string
  start: TakeStart
  live: LiveTakeSignals
  outcome: TakeOutcome
  recording?: { blob: Blob; mimeType: string; facts: RecordingSessionFacts }
  clipId?: string
  saveMs?: number
}): TakeReport {
  const { start, recording } = input
  const sessionSec = (recording?.facts.sessionMs ?? 0) / 1000
  return {
    v: TAKE_REPORT_VERSION,
    id: reportId(start.recordedAt),
    recordedAt: start.recordedAt,
    sessionId: input.sessionId,
    ...(input.clipId ? { clipId: input.clipId } : {}),
    mode: start.mode,
    outcome: input.outcome,
    holdMs: input.live.durationMs,
    quality: start.quality,
    mimeType: recording?.mimeType ?? start.mimeType,
    camera: start.camera,
    ...(recording
      ? {
          encoder: {
            ...recording.facts,
            blobBytes: recording.blob.size,
            kbps: sessionSec > 0 ? Math.round((recording.blob.size * 8) / sessionSec / 1000) : 0,
          },
        }
      : {}),
    ...(input.saveMs !== undefined ? { saveMs: Math.round(input.saveMs) } : {}),
    live: input.live,
    env: start.env,
    verdict: 'unknown',
    reasons: [],
  }
}

const NOMINAL_INTERVAL_MS = 1000 / VIDEO_FPS
/** File time ↔ press time alignment is approximate (encoder start latency). */
const ALIGN_TOLERANCE_MS = 250
/** Encoders younger than this at the press can leak their startup hole. */
const WARM_ENCODER_MS = 250

function overlaps(windows: readonly TimeWindow[], atMs: number, lengthMs: number): boolean {
  const start = atMs - ALIGN_TOLERANCE_MS
  const end = atMs + lengthMs + ALIGN_TOLERANCE_MS
  return windows.some((w) => w.atMs <= end && w.atMs + w.durationMs >= start)
}

/** Which live event a single gap lines up with, most specific first. */
export function reasonForGap(
  report: Pick<TakeReport, 'live' | 'encoder'>,
  gap: { atMs: number; gapMs: number },
): DropReason {
  if (overlaps(report.live.hidden, gap.atMs, gap.gapMs)) return 'backgrounded'
  if (overlaps(report.live.mainThread.stalls, gap.atMs, gap.gapMs)) return 'main-thread'
  if (overlaps(report.live.zoom.windows, gap.atMs, gap.gapMs)) return 'zoom'
  if (gap.atMs === 0 && (report.encoder?.warmAgeMs ?? 0) < WARM_ENCODER_MS) return 'cold-start'
  if (report.live.backgroundWork.length > 0) return 'background-work'
  return 'unexplained'
}

export function verdictFor(cadence: FrameCadence | undefined): TakeVerdict {
  if (!cadence || cadence.expectedFrames === 0) return 'unknown'
  const lossRatio = cadence.droppedFrames / cadence.expectedFrames
  if (cadence.stalls > 0 || lossRatio > 0.05 || cadence.fps < VIDEO_FPS - 5) return 'choppy'
  if (cadence.droppedFrames >= 2) return 'minor'
  return 'smooth'
}

/** Verdict, per-gap reasons, and take-level reasons from a report whose
 * cadence is filled in. Pure — safe to re-run on stored reports. */
export function classifyTake(report: TakeReport): Pick<TakeReport, 'verdict' | 'reasons' | 'gaps'> {
  const cadence = report.cadence
  const verdict = verdictFor(cadence)
  if (!cadence || verdict === 'smooth' || verdict === 'unknown') {
    return { verdict, reasons: [], gaps: [] }
  }
  const reasons = new Set<DropReason>()
  const gaps = cadence.worstGaps.map((gap) => {
    const reason = reasonForGap(report, gap)
    reasons.add(reason)
    return { ...gap, reason }
  })

  if (cadence.medianIntervalMs > NOMINAL_INTERVAL_MS * 1.2) reasons.add('camera-rate')
  const frames = report.encoder?.trackFrames
  const sessionSec = (report.encoder?.sessionMs ?? 0) / 1000
  if (frames && sessionSec > 0.5 && frames.total / sessionSec < VIDEO_FPS - 4) {
    reasons.add('camera-rate')
  }
  if (frames && frames.discarded > 1) reasons.add('frames-discarded')
  const fileFrames = report.wholeFile?.frames
  if (frames && fileFrames !== undefined) {
    const lost = frames.delivered - fileFrames
    if (lost > Math.max(3, frames.delivered * 0.02)) reasons.add('encoder-loss')
  }
  if (report.live.hidden.length > 0) reasons.add('backgrounded')
  if (report.live.backgroundWork.length > 0) reasons.add('background-work')
  if (cadence.headGapMs > NOMINAL_INTERVAL_MS * 1.5) reasons.add('cold-start')
  // Specific causes explain the take; only keep 'unexplained' when alone.
  if (reasons.size > 1) reasons.delete('unexplained')
  return { verdict, reasons: [...reasons], gaps }
}

/** Fill cadence/audio from the file's timestamps and re-classify. */
export function applyTakeAnalysis(
  report: TakeReport,
  stamps: TakeTimestamps,
  window: { startMs: number; endMs: number },
  analysisMs: number,
): TakeReport {
  const cadence = analyzeFrameCadence(stamps.videoSec, window)
  const whole = analyzeFrameCadence(stamps.videoSec)
  const firstVideoSec = stamps.videoSec.length > 0 ? Math.min(...stamps.videoSec) : 0
  const analyzed: TakeReport = {
    ...report,
    cadence,
    wholeFile: {
      frames: whole.frames,
      fps: whole.fps,
      droppedFrames: whole.droppedFrames,
      firstVideoMs: Math.round(firstVideoSec * 1000),
    },
    audio: analyzeAudioContinuity(stamps.audio),
    videoCodec: stamps.videoCodec,
    analysisMs: Math.round(analysisMs),
    analysisError: undefined,
  }
  return { ...analyzed, ...classifyTake(analyzed) }
}

export interface TakeReportSummary {
  takes: number
  analyzed: number
  smooth: number
  minor: number
  choppy: number
  /** Kept-range frames missing across analyzed takes. */
  droppedFrames: number
  expectedFrames: number
  medianFps: number
  /** Takes carrying each reason. */
  reasons: Partial<Record<DropReason, number>>
  firstAt?: number
  lastAt?: number
}

export function summarizeTakeReports(reports: readonly TakeReport[]): TakeReportSummary {
  const analyzed = reports.filter((report) => report.cadence)
  const fps = analyzed.map((report) => report.cadence!.fps).sort((a, b) => a - b)
  const reasons: Partial<Record<DropReason, number>> = {}
  for (const report of reports) {
    for (const reason of report.reasons) reasons[reason] = (reasons[reason] ?? 0) + 1
  }
  const times = reports.map((report) => report.recordedAt)
  return {
    takes: reports.length,
    analyzed: analyzed.length,
    smooth: reports.filter((report) => report.verdict === 'smooth').length,
    minor: reports.filter((report) => report.verdict === 'minor').length,
    choppy: reports.filter((report) => report.verdict === 'choppy').length,
    droppedFrames: analyzed.reduce((sum, report) => sum + report.cadence!.droppedFrames, 0),
    expectedFrames: analyzed.reduce((sum, report) => sum + report.cadence!.expectedFrames, 0),
    medianFps: fps.length > 0 ? fps[Math.floor((fps.length - 1) / 2)]! : 0,
    reasons,
    ...(times.length > 0 ? { firstAt: Math.min(...times), lastAt: Math.max(...times) } : {}),
  }
}

export function describeReason(reason: DropReason): string {
  switch (reason) {
    case 'camera-rate':
      return 'Camera delivered under 25 fps (dim light or heat)'
    case 'frames-discarded':
      return 'Browser discarded frames before recording'
    case 'encoder-loss':
      return 'Encoder lost frames'
    case 'main-thread':
      return 'App was busy (main-thread stall)'
    case 'zoom':
      return 'During drag-to-zoom'
    case 'backgrounded':
      return 'App was hidden mid-take'
    case 'background-work':
      return 'Background work overlapped the take'
    case 'cold-start':
      return 'Encoder was starting up'
    case 'unexplained':
      return 'No matching signal'
    default: {
      const exhaustive: never = reason
      return exhaustive
    }
  }
}
