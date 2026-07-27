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
  if (!Number.isFinite(bytes) || bytes < 0) return '0 MB'
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 1) {
    return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`
  }
  const mb = bytes / (1024 * 1024)
  return `${Math.max(1, Math.round(mb))} MB`
}

export function formatStoragePercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}
