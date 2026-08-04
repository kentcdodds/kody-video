/** Segments shorter than this are dropped — they cannot produce useful frames. */
export const MIN_SEGMENT_MS = 50;
/**
 * Turn ordered clips into a concrete list of segments to render.
 * Clamps trim points to the stored duration and drops degenerate segments
 * instead of failing the whole export.
 */
export function planExport(clips) {
    const segments = [];
    let offsetMs = 0;
    for (const clip of clips) {
        const endMs = Math.min(clip.trimEndMs, clip.durationMs);
        const startMs = Math.max(0, Math.min(clip.trimStartMs, endMs));
        const durationMs = endMs - startMs;
        if (durationMs < MIN_SEGMENT_MS)
            continue;
        segments.push({ clip, startMs, endMs, offsetMs });
        offsetMs += durationMs;
    }
    return { segments, totalMs: offsetMs };
}
/**
 * Re-clamp a planned segment against the real media duration measured after
 * the clip is loaded (stored durations can be wall-clock estimates on old
 * clips). Returns null when nothing playable remains.
 */
export function clampSegmentToMedia(segment, mediaDurationMs) {
    if (!Number.isFinite(mediaDurationMs) || mediaDurationMs <= 0) {
        return { startMs: segment.startMs, endMs: segment.endMs };
    }
    const endMs = Math.min(segment.endMs, mediaDurationMs);
    const startMs = Math.min(segment.startMs, endMs);
    if (endMs - startMs < MIN_SEGMENT_MS)
        return null;
    return { startMs, endMs };
}
