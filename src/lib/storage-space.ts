/** Device storage awareness: clips are big, quotas are finite. */

export interface StorageSpace {
  usedBytes: number
  quotaBytes: number
  /** 0..1 share of the quota already used. */
  ratio: number
}

export type StorageSeverity = 'ok' | 'warning' | 'critical'

export async function estimateStorageSpace(): Promise<StorageSpace | null> {
  try {
    if (!navigator.storage?.estimate) return null
    const { usage, quota } = await navigator.storage.estimate()
    if (!quota || quota <= 0) return null
    const usedBytes = usage ?? 0
    return { usedBytes, quotaBytes: quota, ratio: Math.min(1, usedBytes / quota) }
  } catch {
    return null
  }
}

export function storageSeverity(ratio: number): StorageSeverity {
  if (ratio >= 0.92) return 'critical'
  if (ratio >= 0.8) return 'warning'
  return 'ok'
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 1) {
    return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`
  }
  const mb = bytes / (1024 * 1024)
  return `${Math.max(1, Math.round(mb))} MB`
}

/** Bytes the origin can still write (0 when the estimate is missing). */
export function availableBytes(space: StorageSpace | null | undefined): number {
  if (!space) return 0
  return Math.max(0, space.quotaBytes - space.usedBytes)
}

/**
 * Headroom for IndexedDB overhead and generated thumbs so a backup that
 * *just* fits the remaining quota does not fail midway.
 */
export const IMPORT_SLACK_BYTES = 32 * 1024 * 1024

/** True when a backup of `backupBytes` should fit in the remaining quota. */
export function backupFitsStorage(
  backupBytes: number,
  space: StorageSpace | null | undefined,
): boolean {
  if (!space) return true
  if (!Number.isFinite(backupBytes) || backupBytes <= 0) return true
  return availableBytes(space) >= backupBytes + IMPORT_SLACK_BYTES
}

export function formatStoragePercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

/**
 * Ask the browser to mark this origin's storage persistent so recordings
 * can't be silently evicted under storage pressure. Chromium grants it
 * without any prompt for engaged/installed origins; fire-and-forget.
 */
export async function requestPersistentStorage(): Promise<void> {
  try {
    await navigator.storage?.persist?.()
  } catch {
    // Older browsers: nothing to do.
  }
}
