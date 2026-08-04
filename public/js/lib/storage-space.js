/** Device storage awareness: clips are big, quotas are finite. */
export async function estimateStorageSpace() {
    try {
        if (!navigator.storage?.estimate)
            return null;
        const { usage, quota } = await navigator.storage.estimate();
        if (!quota || quota <= 0)
            return null;
        const usedBytes = usage ?? 0;
        return { usedBytes, quotaBytes: quota, ratio: Math.min(1, usedBytes / quota) };
    }
    catch {
        return null;
    }
}
export function storageSeverity(ratio) {
    if (ratio >= 0.92)
        return 'critical';
    if (ratio >= 0.8)
        return 'warning';
    return 'ok';
}
export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0)
        return '0 MB';
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) {
        return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
    }
    const mb = bytes / (1024 * 1024);
    return `${Math.max(1, Math.round(mb))} MB`;
}
export function formatStoragePercent(ratio) {
    return `${Math.round(ratio * 100)}%`;
}
/**
 * Ask the browser to mark this origin's storage persistent so recordings
 * can't be silently evicted under storage pressure. Chromium grants it
 * without any prompt for engaged/installed origins; fire-and-forget.
 */
export function requestPersistentStorage() {
    try {
        void navigator.storage?.persist?.().catch(() => undefined);
    }
    catch {
        // Older browsers: nothing to do.
    }
}
