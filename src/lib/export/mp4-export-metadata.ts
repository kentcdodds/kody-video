import { deriveProjectLocation } from '../geo'
import type { ClipRecord } from '../types'

type ChapterClip = Pick<ClipRecord, 'createdAt' | 'durationMs' | 'lat' | 'lng'>
type LocatedClip = Pick<ClipRecord, 'lat' | 'lng'>

/** Recording start ≈ createdAt − durationMs (wall-clock capture window). */
function clipRecordingStartMs(clip: Pick<ClipRecord, 'createdAt' | 'durationMs'>): number {
  return clip.createdAt - clip.durationMs
}

export function clipsSpanMultipleDays(
  clips: Pick<ClipRecord, 'createdAt' | 'durationMs'>[],
): boolean {
  if (clips.length <= 1) return false
  const days = new Set<string>()
  for (const clip of clips) {
    const date = new Date(clipRecordingStartMs(clip))
    days.add(`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`)
    if (days.size > 1) return true
  }
  return false
}

export function formatChapterTitle(
  clip: ChapterClip,
  includeDate: boolean,
  includeLocation: boolean,
): string {
  const start = new Date(clipRecordingStartMs(clip))
  const time = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const datePrefix = includeDate
    ? `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })} `
    : ''
  let title = `${datePrefix}${time}`
  if (
    includeLocation &&
    typeof clip.lat === 'number' &&
    Number.isFinite(clip.lat) &&
    typeof clip.lng === 'number' &&
    Number.isFinite(clip.lng)
  ) {
    title += ` · ${clip.lat.toFixed(4)},${clip.lng.toFixed(4)}`
  }
  return title
}

export function locationForExport(
  clips: LocatedClip[],
  includeLocation: boolean,
): { lat: number; lng: number } | null {
  return includeLocation ? deriveProjectLocation(clips) : null
}
