/**
 * "Save clips" as one ZIP. Individual downloads were unusable at 200 clips;
 * a ZIP is one artifact for the share sheet or downloads folder. Clips are
 * already-compressed video, so client-zip's store-mode (no recompression,
 * zip64 for huge projects) is exactly right — and the archive streams to
 * OPFS where available, so even gigabyte projects never sit in RAM.
 */

import { makeZip } from 'client-zip'
import { streamToOpfsFile } from './export/opfs'
import type { ClipRecord } from './types'

function extensionFor(mimeType: string): string {
  return /mp4/i.test(mimeType) ? 'mp4' : 'webm'
}

function clipFilename(clip: ClipRecord, index: number): string {
  const stamp = new Date(clip.createdAt)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ')
    .replace(/:/g, '.')
  return `${String(index + 1).padStart(3, '0')} - ${stamp}.${extensionFor(clip.mimeType)}`
}

/** Build the archive; disk-backed via OPFS when available, in-memory otherwise. */
export async function buildClipsZip(clips: ClipRecord[]): Promise<Blob> {
  // A fresh stream per attempt: a failed OPFS pipe leaves its stream
  // locked, and makeZip reads clip blobs lazily so re-creation is free.
  const createStream = () =>
    makeZip(
      clips.map((clip, index) => ({
        name: clipFilename(clip, index),
        lastModified: new Date(clip.createdAt),
        input: clip.blob,
      })),
    )
  const file = await streamToOpfsFile('clips.zip', createStream())
  if (file) return new Blob([file], { type: 'application/zip' })
  return new Response(createStream()).blob()
}
