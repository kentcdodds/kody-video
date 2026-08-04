import { addClip, createProject, deleteProject, updateClipTrim } from './storage'
import type { ClipRecord, Project } from './types'

/**
 * Single-file project backup, used both as a safety net and to move a
 * project between origins (e.g. kody-video.pages.dev → kody.video, whose
 * browser storage is separate).
 *
 * Format: `KODYVID1` magic, u32 big-endian JSON manifest length, UTF-8 JSON
 * manifest, then every clip's media bytes concatenated in manifest order.
 * Thumbnails are intentionally excluded — the loader regenerates them.
 */
const MAGIC = 'KODYVID1'
const MAGIC_BYTES = new TextEncoder().encode(MAGIC)

interface ManifestClip {
  mimeType: string
  durationMs: number
  trimStartMs: number
  trimEndMs: number
  createdAt: number
  width?: number
  height?: number
  lat?: number
  lng?: number
  locationAccuracyM?: number
  /** Byte length of this clip's media in the blob section. */
  byteLength: number
}

interface Manifest {
  version: 1
  app: 'kody-video'
  exportedAt: number
  projectName: string
  clips: ManifestClip[]
}

export function projectBackupFilename(projectName: string): string {
  const slug =
    projectName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 40) || 'project'
  return `${slug}.kodyvideo`
}

/** Bundle a project into one shareable/downloadable backup Blob. */
export function serializeProject(project: Project, clips: ClipRecord[]): Blob {
  const manifest: Manifest = {
    version: 1,
    app: 'kody-video',
    exportedAt: Date.now(),
    projectName: project.name,
    clips: clips.map((clip) => ({
      mimeType: clip.mimeType,
      durationMs: clip.durationMs,
      trimStartMs: clip.trimStartMs,
      trimEndMs: clip.trimEndMs,
      createdAt: clip.createdAt,
      width: clip.width,
      height: clip.height,
      lat: clip.lat,
      lng: clip.lng,
      locationAccuracyM: clip.locationAccuracyM,
      byteLength: clip.blob.size,
    })),
  }

  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
  const header = new Uint8Array(MAGIC_BYTES.byteLength + 4)
  header.set(MAGIC_BYTES, 0)
  new DataView(header.buffer).setUint32(MAGIC_BYTES.byteLength, manifestBytes.byteLength)

  // Blob composition references the clip blobs — nothing is copied here.
  return new Blob([header, manifestBytes, ...clips.map((clip) => clip.blob)], {
    type: 'application/octet-stream',
  })
}

export interface ParsedBackup {
  projectName: string
  clips: Array<Omit<ManifestClip, 'byteLength'> & { blob: Blob }>
}

/**
 * A file the user picked that isn't a (valid, current) Kody Video backup.
 * Surfaced in-app as guidance; expected user input, never a crash report.
 */
export class BackupFormatError extends Error {
  override readonly name = 'BackupFormatError'
}

/**
 * Parse a backup file. Media bytes are sliced lazily per clip (File.slice),
 * so large backups never need the whole file in memory at once.
 */
export async function parseProjectBackup(file: Blob): Promise<ParsedBackup> {
  const headerLength = MAGIC_BYTES.byteLength + 4
  if (file.size < headerLength) throw new BackupFormatError('Not a Kody Video backup file')

  const header = new Uint8Array(await file.slice(0, headerLength).arrayBuffer())
  for (let i = 0; i < MAGIC_BYTES.byteLength; i += 1) {
    if (header[i] !== MAGIC_BYTES[i]) throw new BackupFormatError('Not a Kody Video backup file')
  }
  const manifestLength = new DataView(header.buffer).getUint32(MAGIC_BYTES.byteLength)
  if (manifestLength <= 0 || headerLength + manifestLength > file.size) {
    throw new BackupFormatError('This backup file is damaged')
  }

  let manifest: Manifest
  try {
    const manifestBytes = await file
      .slice(headerLength, headerLength + manifestLength)
      .arrayBuffer()
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest
  } catch {
    throw new BackupFormatError('This backup file is damaged')
  }
  if (manifest.app !== 'kody-video' || manifest.version !== 1 || !Array.isArray(manifest.clips)) {
    throw new BackupFormatError('This backup was made by a newer app version — update and retry')
  }

  let offset = headerLength + manifestLength
  const clips: ParsedBackup['clips'] = []
  for (const clip of manifest.clips) {
    if (
      !Number.isInteger(clip.byteLength) ||
      clip.byteLength <= 0 ||
      offset + clip.byteLength > file.size
    ) {
      throw new BackupFormatError('This backup file is damaged')
    }
    const mimeType = typeof clip.mimeType === 'string' ? clip.mimeType : 'video/webm'
    clips.push({
      mimeType,
      durationMs: clip.durationMs,
      trimStartMs: clip.trimStartMs,
      trimEndMs: clip.trimEndMs,
      createdAt: clip.createdAt,
      width: clip.width,
      height: clip.height,
      lat: clip.lat,
      lng: clip.lng,
      locationAccuracyM: clip.locationAccuracyM,
      blob: file.slice(offset, offset + clip.byteLength, mimeType),
    })
    offset += clip.byteLength
  }

  return { projectName: String(manifest.projectName || 'Imported project'), clips }
}

function assertImportableClip(clip: ParsedBackup['clips'][number]): void {
  const finite =
    Number.isFinite(clip.durationMs) &&
    Number.isFinite(clip.trimStartMs) &&
    Number.isFinite(clip.trimEndMs) &&
    Number.isFinite(clip.createdAt)
  if (!finite || clip.durationMs <= 0 || clip.blob.size <= 0) {
    throw new BackupFormatError('This backup file is damaged')
  }
}

/** Create a fresh project (new ids) from a parsed backup. */
export async function importProjectBackup(
  parsed: ParsedBackup,
  onProgress?: (doneClips: number, totalClips: number) => void,
): Promise<Project> {
  const project = await createProject(parsed.projectName)
  try {
    let done = 0
    onProgress?.(0, parsed.clips.length)
    for (const clip of parsed.clips) {
      assertImportableClip(clip)
      // CRITICAL: materialize the media bytes. The parsed blob is a lazy
      // slice of the picked backup File; persisting that into IndexedDB
      // stores a reference to the underlying file, which goes stale (esp.
      // Android content URIs) and leaves clips unreadable. Reading it here
      // both copies the bytes and proves the file is intact.
      const bytes = await clip.blob.arrayBuffer()
      const added = await addClip({
        projectId: project.id,
        blob: new Blob([bytes], { type: clip.mimeType }),
        mimeType: clip.mimeType,
        durationMs: clip.durationMs,
        // Keep the original capture time so chapter titles stay truthful.
        createdAt: clip.createdAt,
        width: clip.width,
        height: clip.height,
        lat: clip.lat,
        lng: clip.lng,
        locationAccuracyM: clip.locationAccuracyM,
      })
      // Restore trims (addClip resets them to the full clip).
      const trimmed = await updateClipTrim(added.id, clip.trimStartMs, clip.trimEndMs)
      // Generate thumbnails now so the slot poster shows right away and the
      // first open doesn't pay the backfill cost. Lazy import keeps mediabunny
      // out of the home-shell graph until an import actually runs.
      const { ensureClipThumbs } = await import('./thumbs')
      await ensureClipThumbs({ ...added, ...trimmed, blob: added.blob }).catch(() => undefined)
      done += 1
      onProgress?.(done, parsed.clips.length)
    }
    return project
  } catch (error) {
    // Never leave a half-imported project behind.
    await deleteProject(project.id).catch(() => undefined)
    throw error
  }
}
