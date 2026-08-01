/**
 * Lifecycle management for the OPFS export cache. Export files are big
 * (a half-hour project is ~1GB), and three kinds of them live in the
 * exports directory:
 *
 * - `export-<ts>.<ext>` — the streaming target of an in-flight or
 *   just-finished export (it may back the ExportResult blob on screen)
 * - the recoverable last export referenced by AppMeta.lastExport (which,
 *   when the result was file-backed, IS its `export-<ts>` file — no copy)
 * - `clips.zip` — scratch for the most recent "Save clips" archive
 *
 * Left alone these quietly eat gigabytes: users saw "storage full" after
 * deleting every project. Everything except the referenced last export is
 * swept at boot and before each new export; users can drop the lot from
 * the storage UI.
 */

import { getDb, getSettings, listProjects } from '../storage'
import { listExportEntries, removeExportEntry } from './opfs'

/**
 * Cross-tab coordination: an export in one tab streams into a temp file
 * that no metadata references yet — a sweep or clear from another tab
 * (boot, or the "clear cached exports" button) must not delete it out from
 * under the encoder. Exports hold this lock shared (they can overlap);
 * deleting operations take it exclusive, and only when free.
 */
const CACHE_LOCK = 'kody-video-export-cache'

/** Run `fn` while holding the cache lock shared — sweeps and clears wait
 * out (or skip) anything inside. No-op wrapper without Web Locks. */
export async function withExportCacheReserved<T>(fn: () => Promise<T>): Promise<T> {
  const locks = navigator.locks
  if (!locks?.request) return fn()
  return locks.request(CACHE_LOCK, { mode: 'shared' }, fn)
}

/** Exclusive, non-waiting: deleting cache files is either safe right now or
 * skipped. Returns null when an export holds the lock. */
async function tryExclusive<T>(fn: () => Promise<T>): Promise<T | null> {
  const locks = navigator.locks
  if (!locks?.request) return fn()
  return locks.request(CACHE_LOCK, { mode: 'exclusive', ifAvailable: true }, async (lock) =>
    lock ? fn() : null,
  )
}

/** Total bytes sitting in the export cache (0 when OPFS is unavailable). */
export async function estimateExportCacheBytes(): Promise<number> {
  const entries = await listExportEntries()
  return entries.reduce((sum, entry) => sum + entry.sizeBytes, 0)
}

async function clearLastExportMeta(): Promise<void> {
  const db = await getDb()
  const settings = await getSettings()
  if (!settings.lastExport) return
  await db.put('meta', { ...settings, lastExport: undefined })
}

/**
 * Delete every cached export file, including the recoverable last export
 * (its meta record goes with it). The user-facing "free up space" action.
 * Returns the number of bytes freed; throws when an export is in flight
 * (possibly in another tab) so nothing gets deleted mid-stream.
 */
export async function clearExportCache(): Promise<number> {
  const freed = await tryExclusive(async () => {
    const entries = await listExportEntries()
    await clearLastExportMeta()
    await Promise.all(entries.map((entry) => removeExportEntry(entry.name)))
    return entries.reduce((sum, entry) => sum + entry.sizeBytes, 0)
  })
  if (freed === null) {
    throw new Error('An export is in progress — try again when it finishes.')
  }
  return freed
}

/**
 * Boot/pre-export sweep: delete every cache file except a still-valid
 * last export (its project must still exist). Skipped entirely while any
 * tab is exporting — cleanup is best-effort and gets another chance.
 */
export async function sweepExportCache(): Promise<void> {
  await tryExclusive(async () => {
    const entries = await listExportEntries()
    if (entries.length === 0) return

    const settings = await getSettings()
    let keep: string | null = null
    if (settings.lastExport) {
      const projects = await listProjects()
      const projectExists = projects.some(
        (project) => project.id === settings.lastExport?.projectId,
      )
      if (projectExists) {
        keep = settings.lastExport.opfsName
      } else {
        await clearLastExportMeta()
      }
    }

    await Promise.all(
      entries
        .filter((entry) => entry.name !== keep)
        .map((entry) => removeExportEntry(entry.name)),
    )
  })
}
