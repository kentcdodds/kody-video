export const MAX_PROJECTS = 6;
/** Projects included without the Kody Video Plus purchase. */
export const FREE_PROJECTS = 1;
/** Route id for a project that exists only as a URL until the first clip is
 * recorded — backing out of an empty "new project" leaves nothing behind. */
export const NEW_PROJECT_ID = 'new';
export function effectiveDurationMs(clip) {
    const end = Math.min(clip.trimEndMs, clip.durationMs);
    const start = Math.max(0, Math.min(clip.trimStartMs, end));
    return Math.max(0, end - start);
}
export function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const tenths = Math.floor((ms % 1000) / 100);
    if (minutes > 0) {
        return `${minutes}:${seconds.toString().padStart(2, '0')}.${tenths}`;
    }
    return `${seconds}.${tenths}s`;
}
export function newId(prefix) {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        return `${prefix}_${crypto.randomUUID()}`;
    }
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
