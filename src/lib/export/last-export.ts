/**
 * Recoverable last export. Missing the share sheet used to mean re-encoding
 * the whole project (half an hour of video = many minutes of work). After a
 * successful export, the file is persisted to OPFS with a fingerprint of
 * exactly what produced it; tapping Go on an unchanged project serves it
 * instantly, and Retry always forces a fresh encode.
 */

import { getDb, getSettings } from '../storage'
import type { ClipRecord, ProjectId } from '../types'
import { readOpfsFile, streamToOpfsFile } from './opfs'
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
 * which case the feature simply doesn't exist on this browser). The blob
 * streams to disk, so disk-backed results never occupy RAM twice; the
 * metadata is committed only after the bytes are safely written.
 */
export async function persistLastExport(args: {
  projectId: ProjectId
  result: ExportResult
  signature: string
  watermarked: boolean
}): Promise<void> {
  const { projectId, result, signature, watermarked } = args
  const opfsName = `${LAST_EXPORT_PREFIX}.${result.fileExtension}`
  const file = await streamToOpfsFile(opfsName, result.blob.stream())
  if (!file || file.size !== result.blob.size) return

  const db = await getDb()
  const settings = await getSettings()
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
