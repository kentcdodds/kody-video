/**
 * Recoverable last export. Missing the share sheet used to mean re-encoding
 * the whole project (half an hour of video = many minutes of work). After a
 * successful export, the file is persisted to OPFS with a fingerprint of
 * exactly what produced it; tapping Go on an unchanged project serves it
 * instantly, and Retry always forces a fresh encode.
 */

import { getDb, getSettings } from '../storage'
import type { ClipRecord, ProjectId } from '../types'
import { withExportCacheReserved } from './export-cache'
import { readOpfsFile, removeExportEntry, streamToOpfsFile } from './opfs'
import type { ExportResult } from './shared'

const LAST_EXPORT_PREFIX = 'last-export'

/** Anything that changes the rendered output must change the signature. */
export function exportSignature(clips: ClipRecord[], watermarked: boolean): string {
  return JSON.stringify({
    watermarked,
    clips: clips.map((clip) => [clip.id, clip.trimStartMs, clip.trimEndMs]),
  })
}

/**
 * Persist a finished export (best effort — OPFS may be unavailable, in
 * which case the feature simply doesn't exist on this browser).
 *
 * File-backed results are adopted in place — the export already lives on
 * disk, and copying a ~1GB file just to rename it doubled the app's disk
 * footprint. In-memory results (metadata-injected MP4s, the realtime
 * engine) stream to a well-known name, and their now-superseded temp file
 * is removed. Either way, the previously cached export file is dropped
 * once the new record is committed.
 */
export async function persistLastExport(args: {
  projectId: ProjectId
  result: ExportResult
  signature: string
  watermarked: boolean
}): Promise<void> {
  // Reserved against concurrent sweeps: the file being adopted/copied has
  // no committed metadata reference until the put below lands.
  await withExportCacheReserved(() => persistLastExportInner(args))
}

async function persistLastExportInner(args: {
  projectId: ProjectId
  result: ExportResult
  signature: string
  watermarked: boolean
}): Promise<void> {
  const { projectId, result, signature, watermarked } = args

  let opfsName: string
  if (result.opfsBacked && result.opfsName) {
    opfsName = result.opfsName
  } else {
    opfsName = `${LAST_EXPORT_PREFIX}.${result.fileExtension}`
    const file = await streamToOpfsFile(opfsName, result.blob.stream())
    if (!file || file.size !== result.blob.size) return
    // The streaming temp behind this export (if any) is superseded by the
    // copy we just wrote — reclaim it now instead of at the next sweep.
    if (result.opfsName && result.opfsName !== opfsName) {
      await removeExportEntry(result.opfsName).catch(() => undefined)
    }
  }

  const db = await getDb()
  const settings = await getSettings()
  const previousName = settings.lastExport?.opfsName
  await db.put('meta', {
    ...settings,
    lastExport: {
      projectId,
      opfsName,
      mimeType: result.mimeType,
      fileExtension: result.fileExtension,
      createdAt: Date.now(),
      signature,
      watermarked,
    },
  })
  if (previousName && previousName !== opfsName) {
    await removeExportEntry(previousName).catch(() => undefined)
  }
}

export interface RecoveredExport {
  result: ExportResult
  watermarked: boolean
  createdAt: number
}

/**
 * The stored export for this exact project + signature, or null when it
 * doesn't exist, doesn't match, or its file has vanished.
 */
export async function loadMatchingExport(
  projectId: ProjectId,
  signature: string,
): Promise<RecoveredExport | null> {
  const settings = await getSettings()
  const last = settings.lastExport
  if (!last || last.projectId !== projectId || last.signature !== signature) return null
  const file = await readOpfsFile(last.opfsName)
  if (!file || file.size === 0) return null
  return {
    result: {
      blob: new Blob([file], { type: last.mimeType }),
      mimeType: last.mimeType,
      fileExtension: last.fileExtension,
    },
    watermarked: last.watermarked,
    createdAt: last.createdAt,
  }
}
