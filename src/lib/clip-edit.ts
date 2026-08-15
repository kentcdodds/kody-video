import {
  effectiveDurationMs,
  isImageClip,
  type ClipMeta,
} from './types'

/** Shortest piece we will encode or keep after a permanent trim / split.
 * Stays above the export planner's 50ms drop threshold. */
export const MIN_SLICE_MS = 100

export function clipHasUnusedMedia(
  clip: Pick<ClipMeta, 'durationMs' | 'trimStartMs' | 'trimEndMs' | 'kind'>,
): boolean {
  if (isImageClip(clip)) return false
  const kept = effectiveDurationMs(clip)
  return kept >= MIN_SLICE_MS && kept < clip.durationMs - 1
}

export function canSplitClip(
  clip: Pick<ClipMeta, 'durationMs' | 'trimStartMs' | 'trimEndMs' | 'kind'>,
): boolean {
  if (isImageClip(clip)) return false
  return effectiveDurationMs(clip) >= MIN_SLICE_MS * 2
}

/** Kept window and the legal cut range (each half at least `MIN_SLICE_MS`). */
export function splitBounds(
  clip: Pick<ClipMeta, 'durationMs' | 'trimStartMs' | 'trimEndMs'>,
): { start: number; end: number; min: number; max: number } {
  const end = Math.min(clip.trimEndMs, clip.durationMs)
  const start = Math.max(0, Math.min(clip.trimStartMs, end))
  return {
    start,
    end,
    min: start + MIN_SLICE_MS,
    max: end - MIN_SLICE_MS,
  }
}

/** Clamp a proposed cut into the legal split range (or the midpoint if none). */
export function clampSplitMs(
  clip: Pick<ClipMeta, 'durationMs' | 'trimStartMs' | 'trimEndMs'>,
  splitMs: number,
): number {
  const { start, end, min, max } = splitBounds(clip)
  const mid = start + (end - start) / 2
  if (max < min || !Number.isFinite(splitMs)) return mid
  return Math.max(min, Math.min(splitMs, max))
}

/** Absolute source time at which a split should cut. Uses the playhead when
 * it sits far enough inside the kept window; otherwise the kept midpoint. */
export function resolveSplitMs(
  clip: Pick<ClipMeta, 'durationMs' | 'trimStartMs' | 'trimEndMs'>,
  playheadMs: number | null,
): number {
  const { start, end, min, max } = splitBounds(clip)
  const mid = start + (end - start) / 2
  if (playheadMs === null || !Number.isFinite(playheadMs)) return mid
  if (playheadMs >= min && playheadMs <= max) return playheadMs
  return mid
}

/** Remap a source-window trim onto a sliced blob that starts at `offsetMs`. */
export function remapTrimToSlice(
  clip: Pick<ClipMeta, 'durationMs' | 'trimStartMs' | 'trimEndMs'>,
  offsetMs: number,
  sliceDurationMs: number,
): { trimStartMs: number; trimEndMs: number } {
  const sourceEnd = Math.min(clip.trimEndMs, clip.durationMs)
  const sourceStart = Math.max(0, Math.min(clip.trimStartMs, sourceEnd))
  const start = Math.max(0, Math.min(sourceStart - offsetMs, sliceDurationMs))
  const end = Math.max(start, Math.min(sourceEnd - offsetMs, sliceDurationMs))
  return { trimStartMs: start, trimEndMs: end }
}
