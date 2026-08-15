import { formatDuration, isImageClip, type ClipRecord } from './types'
import { clipHasUnusedMedia } from './clip-edit'

export interface ClipFact {
  label: string
  value: string
}

export function formatClipBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  const mb = bytes / (1024 * 1024)
  if (mb < 10) return `${Math.round(mb * 10) / 10} MB`
  return `${Math.round(mb)} MB`
}

export function formatClipMime(mimeType: string): string {
  const lower = mimeType.toLowerCase()
  if (lower.includes('mp4') || lower.includes('quicktime')) return 'MP4'
  if (lower.includes('webm')) return 'WebM'
  if (lower.includes('quicktime')) return 'MOV'
  if (lower.includes('jpeg') || lower.includes('jpg')) return 'JPEG'
  if (lower.includes('png')) return 'PNG'
  if (lower.includes('webp')) return 'WebP'
  if (lower.includes('heic') || lower.includes('heif')) return 'HEIC'
  if (lower.includes('gif')) return 'GIF'
  const subtype = lower.split('/')[1]?.split(';')[0]
  return subtype ? subtype.toUpperCase() : mimeType
}

export function formatClipAspect(width: number, height: number): string | null {
  if (!(width > 0) || !(height > 0)) return null
  const g = gcd(Math.round(width), Math.round(height))
  const rw = Math.round(width) / g
  const rh = Math.round(height) / g
  if (rw <= 32 && rh <= 32) return `${rw}:${rh}`
  return `${(width / height).toFixed(2)}:1`
}

export function formatLatLng(lat: number, lng: number): string {
  const ns = lat >= 0 ? 'N' : 'S'
  const ew = lng >= 0 ? 'E' : 'W'
  return `${Math.abs(lat).toFixed(4)}° ${ns}, ${Math.abs(lng).toFixed(4)}° ${ew}`
}

export function clipDownloadExtension(mimeType: string): string {
  const lower = mimeType.toLowerCase()
  if (lower.includes('mp4') || lower.includes('quicktime')) return 'mp4'
  if (lower.includes('webm')) return 'webm'
  if (lower.includes('png')) return 'png'
  if (lower.includes('webp')) return 'webp'
  if (lower.includes('gif')) return 'gif'
  if (lower.includes('heic')) return 'heic'
  if (lower.includes('heif')) return 'heif'
  if (lower.startsWith('image/')) return 'jpg'
  return 'webm'
}

export function clipDownloadFilename(
  projectName: string,
  index: number,
  mimeType: string,
): string {
  const ext = clipDownloadExtension(mimeType)
  return `${slugify(projectName)}-clip-${String(index + 1).padStart(2, '0')}.${ext}`
}

export function buildClipFacts(
  clip: ClipRecord,
  options: { index: number; clipCount: number; filmDurationMs: number },
): ClipFact[] {
  const facts: ClipFact[] = []
  const photo = isImageClip(clip)
  facts.push({
    label: photo ? 'Photo' : 'Clip',
    value: `${options.index + 1} of ${options.clipCount}`,
  })

  const kept = Math.max(0, Math.min(clip.trimEndMs, clip.durationMs) - Math.max(0, clip.trimStartMs))
  if (photo) {
    facts.push({ label: 'On screen', value: formatDuration(clip.durationMs) })
  } else if (clipHasUnusedMedia(clip)) {
    facts.push({
      label: 'Kept',
      value: `${formatDuration(kept)} of ${formatDuration(clip.durationMs)}`,
    })
    const dropped = clip.durationMs - kept
    facts.push({ label: 'Unused', value: `${formatDuration(dropped)} still in the file` })
  } else {
    facts.push({ label: 'Duration', value: formatDuration(clip.durationMs) })
  }

  if (clip.width && clip.height) {
    const aspect = formatClipAspect(clip.width, clip.height)
    facts.push({
      label: 'Size',
      value: aspect
        ? `${clip.width} × ${clip.height} · ${aspect}`
        : `${clip.width} × ${clip.height}`,
    })
  }

  facts.push({ label: 'File', value: `${formatClipBytes(clip.blob.size)} · ${formatClipMime(clip.mimeType)}` })
  facts.push({ label: 'Recorded', value: formatRecordedAt(clip.createdAt) })

  if (typeof clip.lat === 'number' && typeof clip.lng === 'number') {
    const accuracy =
      typeof clip.locationAccuracyM === 'number' && Number.isFinite(clip.locationAccuracyM)
        ? ` (±${Math.round(clip.locationAccuracyM)} m)`
        : ''
    facts.push({ label: 'Location', value: `${formatLatLng(clip.lat, clip.lng)}${accuracy}` })
  }

  if (options.filmDurationMs > 0 && options.clipCount > 0) {
    const share = Math.round((kept / options.filmDurationMs) * 100)
    facts.push({
      label: 'Of the film',
      value: `${Math.max(0, Math.min(100, share))}%`,
    })
  }

  if (!photo && typeof clip.audioPeak === 'number' && Number.isFinite(clip.audioPeak)) {
    facts.push({ label: 'Audio', value: describeAudioPeak(clip.audioPeak) })
  }

  return facts
}

function describeAudioPeak(peak: number): string {
  if (peak <= 0.005) return 'Silent'
  if (peak < 0.08) return 'Quiet'
  if (peak < 0.35) return 'Moderate'
  return 'Loud'
}

function formatRecordedAt(createdAt: number): string {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return 'Unknown'
  try {
    return new Date(createdAt).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
  } catch {
    return 'Unknown'
  }
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y !== 0) {
    const next = x % y
    x = y
    y = next
  }
  return x || 1
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 40) || 'project'
  )
}

