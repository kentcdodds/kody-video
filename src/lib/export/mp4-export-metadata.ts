import { deriveProjectLocation } from '../geo'
import { isImageClip, type ClipRecord } from '../types'

type ChapterClip = Pick<ClipRecord, 'createdAt' | 'durationMs' | 'lat' | 'lng'>
type LocatedClip = Pick<ClipRecord, 'lat' | 'lng'>
type CompositionClip = Pick<ClipRecord, 'kind' | 'createdAt' | 'durationMs'>

export const KODY_VIDEO_SITE = 'https://kody.video'
export const KODY_VIDEO_ENCODER = 'Kody Video (https://kody.video)'
export const KODY_VIDEO_TITLE_FALLBACK = 'Kody Video'

export interface ExportDescriptiveMetadataInput {
  projectName?: string
  clips: CompositionClip[]
  filmDurationMs: number
  hasMusic: boolean
  includeLocation: boolean
}

export interface ExportDescriptiveMetadata {
  title: string
  encoder: string
  description: string
  comment: string
  /**
   * QuickTime `©day` for the last timeline video that has a capture time —
   * only when location is opted in.
   */
  date?: string
  /** Same instant as `date`, for patching `mvhd`/`tkhd`/`mdhd` creation_time. */
  creationTimeMs?: number
}

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
  const datePrefix =
    includeDate && includeLocation
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

/**
 * Title, encoder, comment, and description for an MP4 share. Location-off
 * is treated as a public share: no filming dates, coordinates, or other
 * capture-context that could identify the person who made the film.
 */
export function buildExportDescriptiveMetadata(
  input: ExportDescriptiveMetadataInput,
): ExportDescriptiveMetadata {
  const title = sanitizeMetadataText(input.projectName) || KODY_VIDEO_TITLE_FALLBACK
  const mix = formatClipMix(input.clips)
  const duration = formatMetadataDuration(input.filmDurationMs)
  const parts = [mix, duration]
  if (input.hasMusic) parts.push('with music')

  const commentParts = [...parts, 'kody.video']
  const descriptionLines = [`${parts.join(' · ')}`]

  let date: string | undefined
  let creationTimeMs: number | undefined
  if (input.includeLocation) {
    const captureMs = lastCaptureTimeMs(input.clips)
    const range = filmedLocalDateRange(input.clips)
    if (captureMs !== null) {
      creationTimeMs = captureMs
      date = formatQuickTimeDay(captureMs)
    }
    if (range) {
      descriptionLines.push(
        range.start === range.end
          ? `Filmed ${range.start}`
          : `Filmed ${range.start} – ${range.end}`,
      )
    }
  }

  descriptionLines.push(`Made with Kody Video — ${KODY_VIDEO_SITE}`)

  return {
    title,
    encoder: KODY_VIDEO_ENCODER,
    comment: commentParts.join(' · '),
    description: descriptionLines.join('\n'),
    date,
    creationTimeMs,
  }
}

/**
 * Capture time of the last timeline video that has `createdAt`. Photos and
 * imported stills are skipped so a trailing photo does not move the film;
 * if the film is photos-only, the last photo's time is used.
 */
export function lastCaptureTimeMs(
  clips: Pick<ClipRecord, 'kind' | 'createdAt'>[],
): number | null {
  for (let i = clips.length - 1; i >= 0; i -= 1) {
    if (isImageClip(clips[i])) continue
    if (Number.isFinite(clips[i].createdAt)) return clips[i].createdAt
  }
  for (let i = clips.length - 1; i >= 0; i -= 1) {
    if (Number.isFinite(clips[i].createdAt)) return clips[i].createdAt
  }
  return null
}

/** Local ISO-8601 with offset — what Photos reads from QuickTime `©day`. */
export function formatQuickTimeDay(ms: number): string {
  const date = new Date(ms)
  const offsetMin = -date.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}${sign}${pad2(Math.floor(abs / 60))}${pad2(abs % 60)}`
}

export function formatClipMix(clips: Pick<ClipRecord, 'kind'>[]): string {
  const photos = clips.filter((clip) => isImageClip(clip)).length
  const videos = clips.length - photos
  if (photos === 0) return clips.length === 1 ? '1 clip' : `${clips.length} clips`
  if (videos === 0) return photos === 1 ? '1 photo' : `${photos} photos`
  return `${clips.length} clips (${plural(videos, 'video')}, ${plural(photos, 'photo')})`
}

export function formatMetadataDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return `${hours}:${pad2(minutes)}:${pad2(seconds)}`
  }
  if (minutes > 0) return `${minutes}:${pad2(seconds)}`
  return `${totalSeconds}s`
}

function filmedLocalDateRange(
  clips: Pick<ClipRecord, 'createdAt' | 'durationMs'>[],
): { start: string; end: string } | null {
  if (clips.length === 0) return null
  let start = ''
  let end = ''
  for (const clip of clips) {
    const day = localIsoDate(clipRecordingStartMs(clip))
    if (!start || day < start) start = day
    if (!end || day > end) end = day
  }
  return start && end ? { start, end } : null
}

function localIsoDate(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function sanitizeMetadataText(value: string | undefined): string {
  return value?.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim() ?? ''
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}
