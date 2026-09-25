import { VIDEO_FPS } from './video-quality'

/**
 * Frame-cadence analysis of a recorded take, read from the encoded file's
 * own video timestamps — the ground truth for "did this clip drop frames".
 * Live counters (track stats, main-thread lag) explain WHY; these numbers
 * say WHAT the saved memory actually contains. Timings only, never pixels.
 */

/** Missing frames per gap, bucketed. "0" is an on-time frame (jitter up to
 * half a frame interval); "9+" is a visible freeze of ~300ms or more. */
export const GAP_BUCKETS = ['0', '1', '2-3', '4-8', '9+'] as const
export type GapBucket = (typeof GAP_BUCKETS)[number]

export interface FrameCadence {
  /** Video frames presented inside the analyzed window. */
  frames: number
  /** Frames a steady `nominalFps` would have produced in the window. */
  expectedFrames: number
  /** Window length in ms (the kept range of the take). */
  windowMs: number
  /** Achieved rate across the window. */
  fps: number
  /** Median frame interval — reveals the camera's native rate
   * (~33ms = 30fps, ~42ms = 24fps, ~67ms = 15fps low-light exposure). */
  medianIntervalMs: number
  p95IntervalMs: number
  maxGapMs: number
  /** Estimated frames missing from the 30fps cadence, summed over every
   * gap (including a late first frame and an early last one). */
  droppedFrames: number
  /** Gaps of 3+ missing frames (~100ms): a hitch a viewer notices. */
  stalls: number
  gapHistogram: Record<GapBucket, number>
  /** Window start → first frame. A large value is a frozen/black head
   * (encoder startup hole inside the kept range). */
  headGapMs: number
  /** Gap list (window-relative start, ms length) for the worst gaps, so a
   * report can line them up with live events. Capped. */
  worstGaps: Array<{ atMs: number; gapMs: number; missing: number }>
}

export interface CadenceWindow {
  startMs: number
  endMs: number
}

const WORST_GAPS_KEPT = 8

/** Frames missing between two frames `gapMs` apart at `intervalMs`. */
export function missingFramesInGap(gapMs: number, intervalMs: number): number {
  if (!(gapMs > 0) || !(intervalMs > 0)) return 0
  return Math.max(0, Math.round(gapMs / intervalMs) - 1)
}

export function gapBucket(missing: number): GapBucket {
  if (missing <= 0) return '0'
  if (missing === 1) return '1'
  if (missing <= 3) return '2-3'
  if (missing <= 8) return '4-8'
  return '9+'
}

function emptyHistogram(): Record<GapBucket, number> {
  return { '0': 0, '1': 0, '2-3': 0, '4-8': 0, '9+': 0 }
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]!
}

const round1 = (value: number) => Math.round(value * 10) / 10

/**
 * Analyze presentation timestamps (seconds, any order — B-frames reorder
 * decode order) against a steady `nominalFps`, restricted to `window`
 * (the trimmed range the user keeps; pre-roll and stop grace are not
 * part of the memory). Without a window the whole file is analyzed.
 */
export function analyzeFrameCadence(
  timestampsSec: readonly number[],
  window?: CadenceWindow,
  nominalFps: number = VIDEO_FPS,
): FrameCadence {
  const intervalMs = 1000 / nominalFps
  const all = timestampsSec
    .filter((ts) => Number.isFinite(ts))
    .map((ts) => ts * 1000)
    .sort((a, b) => a - b)
  const startMs = window ? window.startMs : (all[0] ?? 0)
  const endMs = window ? window.endMs : all.length > 0 ? all.at(-1)! + intervalMs : 0
  const windowMs = Math.max(0, endMs - startMs)
  const inWindow = all.filter((ts) => ts >= startMs && ts < endMs)

  const histogram = emptyHistogram()
  const gaps: Array<{ atMs: number; gapMs: number; missing: number }> = []
  const intervals: number[] = []
  let dropped = 0
  let stalls = 0
  let maxGapMs = 0

  const countGap = (atMs: number, gapMs: number, isEdge: boolean) => {
    // Edges compare against the window boundary, where a frame is due
    // within one interval — so a gap there misses one frame fewer.
    const missing = isEdge
      ? Math.max(0, Math.round(gapMs / intervalMs))
      : missingFramesInGap(gapMs, intervalMs)
    if (!isEdge) {
      intervals.push(gapMs)
      histogram[gapBucket(missing)] += 1
    }
    if (gapMs > maxGapMs) maxGapMs = gapMs
    if (missing <= 0) return
    dropped += missing
    if (missing >= 3) stalls += 1
    gaps.push({ atMs: Math.round(atMs - startMs), gapMs: Math.round(gapMs), missing })
  }

  const headGapMs = inWindow.length > 0 ? inWindow[0]! - startMs : windowMs
  if (inWindow.length === 0) {
    countGap(startMs, windowMs, true)
  } else {
    countGap(startMs, headGapMs, true)
    for (let i = 1; i < inWindow.length; i += 1) {
      countGap(inWindow[i - 1]!, inWindow[i]! - inWindow[i - 1]!, false)
    }
    // The last frame stays on screen for one interval; anything beyond
    // that before the window closes is a tail freeze.
    const tailMs = endMs - (inWindow.at(-1)! + intervalMs)
    if (tailMs > 0) countGap(inWindow.at(-1)! + intervalMs, tailMs, true)
  }

  const sortedIntervals = [...intervals].sort((a, b) => a - b)
  gaps.sort((a, b) => b.gapMs - a.gapMs)

  return {
    frames: inWindow.length,
    expectedFrames: Math.round(windowMs / intervalMs),
    windowMs: Math.round(windowMs),
    fps: windowMs > 0 ? round1((inWindow.length * 1000) / windowMs) : 0,
    medianIntervalMs: round1(percentile(sortedIntervals, 0.5)),
    p95IntervalMs: round1(percentile(sortedIntervals, 0.95)),
    maxGapMs: Math.round(maxGapMs),
    droppedFrames: dropped,
    stalls,
    gapHistogram: histogram,
    headGapMs: Math.round(Math.max(0, headGapMs)),
    worstGaps: gaps.slice(0, WORST_GAPS_KEPT),
  }
}

export interface AudioContinuity {
  /** Audio packets in the whole file. */
  packets: number
  /** Discontinuities: a packet starting later than the previous one ended
   * (by more than `AUDIO_GAP_TOLERANCE_MS`). Audible as a click/dropout. */
  gaps: number
  maxGapMs: number
  /** File time (ms) of the worst discontinuities, for lining up with live
   * events. Capped. */
  gapAtMs: number[]
  /** First audio timestamp in the file (ms). */
  firstMs: number
}

const AUDIO_GAP_TOLERANCE_MS = 10
const AUDIO_GAPS_KEPT = 4

export function analyzeAudioContinuity(
  packets: ReadonlyArray<{ timestampSec: number; durationSec: number }>,
): AudioContinuity {
  const sorted = [...packets].sort((a, b) => a.timestampSec - b.timestampSec)
  const found: Array<{ atMs: number; gapMs: number }> = []
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1]!
    const expectedStart = previous.timestampSec + previous.durationSec
    const gapMs = (sorted[i]!.timestampSec - expectedStart) * 1000
    if (gapMs > AUDIO_GAP_TOLERANCE_MS) found.push({ atMs: expectedStart * 1000, gapMs })
  }
  const worst = [...found].sort((a, b) => b.gapMs - a.gapMs).slice(0, AUDIO_GAPS_KEPT)
  return {
    packets: sorted.length,
    gaps: found.length,
    maxGapMs: Math.round(worst[0]?.gapMs ?? 0),
    gapAtMs: worst.map((gap) => Math.round(gap.atMs)),
    firstMs: Math.round((sorted[0]?.timestampSec ?? 0) * 1000),
  }
}

export interface TakeTimestamps {
  videoSec: number[]
  audio: Array<{ timestampSec: number; durationSec: number }>
  /** Video codec string as the container reports it (e.g. avc1.640028). */
  videoCodec: string | null
}

/**
 * Read every packet's timing from a recorded blob WITHOUT loading packet
 * data or opening a decoder (metadata-only demux). MP4 sample tables make
 * this nearly free; WebM walks block headers. Callers must run it off the
 * capture path (see capture-activity.ts) — it still reads the file.
 */
export async function readTakeTimestamps(blob: Blob): Promise<TakeTimestamps> {
  // Code-split like measureBlobDuration: mediabunny stays out of the shell.
  const { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } = await import('mediabunny')
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const videoTrack = await input.getPrimaryVideoTrack()
    const audioTrack = await input.getPrimaryAudioTrack()
    const videoSec: number[] = []
    const audio: TakeTimestamps['audio'] = []
    if (videoTrack) {
      const sink = new EncodedPacketSink(videoTrack)
      for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
        videoSec.push(packet.timestamp)
      }
    }
    if (audioTrack) {
      const sink = new EncodedPacketSink(audioTrack)
      for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
        audio.push({ timestampSec: packet.timestamp, durationSec: packet.duration })
      }
    }
    const videoCodec = videoTrack ? await videoTrack.getCodecParameterString().catch(() => null) : null
    return { videoSec, audio, videoCodec }
  } finally {
    input.dispose()
  }
}
