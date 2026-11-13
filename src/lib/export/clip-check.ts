import { findClipVideoProblem, type ClipVideoProblem } from '../clip-video-check'
import { isImageClip, type ClipId, type ClipRecord } from '../types'

export interface UnexportableClip {
  clipId: ClipId
  /** 1-based position in the project, as the filmstrip numbers clips. */
  position: number
  problem: ClipVideoProblem
}

/** Export preflight found clips with no video (e.g. audio-only takes saved
 * before recordings were validated). Lists every one, not just the first. */
export class UnexportableClipsError extends Error {
  readonly clips: UnexportableClip[]
  constructor(clips: UnexportableClip[]) {
    super(unexportableClipsMessage(clips.map((clip) => clip.position)))
    this.name = 'UnexportableClipsError'
    this.clips = clips
  }
}

function joinPositions(positions: readonly number[]): string {
  if (positions.length <= 1) return positions.join('')
  if (positions.length === 2) return `${positions[0]} and ${positions[1]}`
  return `${positions.slice(0, -1).join(', ')}, and ${positions[positions.length - 1]}`
}

export function unexportableClipsMessage(positions: readonly number[]): string {
  return positions.length === 1
    ? `Clip ${positions[0]} has no video and can't be exported.`
    : `Clips ${joinPositions(positions)} have no video and can't be exported.`
}

export function deleteUnexportableClipsLabel(positions: readonly number[]): string {
  return positions.length === 1
    ? `Delete clip ${positions[0]} and export`
    : `Delete ${positions.length} clips and export`
}

/** Clip media never changes in place, so one probe per clip blob is enough
 * (the filmstrip and every export reuse it). */
const probeCache = new Map<string, Promise<ClipVideoProblem | null>>()

export function probeClipForExport(clip: ClipRecord): Promise<ClipVideoProblem | null> {
  if (isImageClip(clip)) return Promise.resolve(null)
  const key = `${clip.id}:${clip.blob.size}`
  let pending = probeCache.get(key)
  if (!pending) {
    pending = findClipVideoProblem(clip.blob).catch(() => null)
    probeCache.set(key, pending)
  }
  return pending
}

export async function findUnexportableClips(
  clips: readonly ClipRecord[],
): Promise<UnexportableClip[]> {
  const problems = await Promise.all(clips.map(probeClipForExport))
  const found: UnexportableClip[] = []
  problems.forEach((problem, index) => {
    const clip = clips[index]
    if (problem && clip) found.push({ clipId: clip.id, position: index + 1, problem })
  })
  return found
}
