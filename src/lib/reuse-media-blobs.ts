import type { ClipRecord, ProjectAudioRecord } from './types'

/** IndexedDB returns a new Blob wrapper for the same bytes on every read.
 * Reusing the live object keeps <video>/<audio> `src` stable so a refresh
 * (filmstrip refine, hydrate, trim persist) cannot stop a playing preview. */
export function sameMediaBlob(previous: Blob, next: Blob): boolean {
  return previous === next || (previous.size === next.size && previous.type === next.type)
}

export function reuseClipMediaBlobs(previous: ClipRecord[], next: ClipRecord[]): ClipRecord[] {
  if (previous.length === 0) return next
  const prevById = new Map(previous.map((clip) => [clip.id, clip]))
  return next.map((clip) => {
    const prior = prevById.get(clip.id)
    if (!prior || prior.blob === clip.blob) return clip
    if (sameMediaBlob(prior.blob, clip.blob)) return { ...clip, blob: prior.blob }
    return clip
  })
}

export function reuseAudioMediaBlobs(
  previous: ProjectAudioRecord | null,
  next: ProjectAudioRecord | null,
): ProjectAudioRecord | null {
  if (!previous || !next) return next
  const prevById = new Map(previous.tracks.map((track) => [track.id, track]))
  let changed = false
  const tracks = next.tracks.map((track) => {
    const prior = prevById.get(track.id)
    if (!prior || prior.blob === track.blob) return track
    if (!sameMediaBlob(prior.blob, track.blob)) return track
    changed = true
    return { ...track, blob: prior.blob }
  })
  return changed ? { ...next, tracks } : next
}
