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

/** Absolute source time at which a split should cut. Uses the playhead when
 * it sits far enough inside the kept window; otherwise the kept midpoint. */
export function resolveSplitMs(
  clip: Pick<ClipMeta, 'durationMs' | 'trimStartMs' | 'trimEndMs'>,
  playheadMs: number | null,
): number {
  const end = Math.min(clip.trimEndMs, clip.durationMs)
  const start = Math.max(0, Math.min(clip.trimStartMs, end))
  const mid = start + (end - start) / 2
  if (playheadMs === null || !Number.isFinite(playheadMs)) return mid
  if (playheadMs >= start + MIN_SLICE_MS && playheadMs <= end - MIN_SLICE_MS) {
    return playheadMs
  }
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
