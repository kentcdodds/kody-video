import { EXPORT_SIZE_IDS, type ExportSize, type ProjectOrientation } from '../types'
import { VIDEO_LONG_EDGE, videoBitrateFor } from '../video-quality'
import { pickOutputSize } from './shared'

export const EXPORT_SIZE_LONG_EDGE: Record<ExportSize, number> = {
  full: VIDEO_LONG_EDGE,
  '720p': 1280,
  '480p': 854,
}

export const EXPORT_SIZE_LABEL: Record<ExportSize, string> = {
  full: 'Full',
  '720p': '720p',
  '480p': '480p',
}

const EXPORT_SIZE_HINT: Record<ExportSize, string> = {
  full: 'sharpest',
  '720p': 'smaller file, still crisp on phones',
  '480p': 'smallest, for messaging apps',
}

/** AAC/Opus bitrate both engines target; part of the size estimate. */
export const EXPORT_AUDIO_BITRATE = 192_000

export interface ExportSizeOption {
  id: ExportSize
  width: number
  height: number
  estimatedBytes: number
}

/** Rough file size: both engines target this bitrate, so real files land
 * near (usually under) it. */
export function estimateExportBytes(width: number, height: number, durationMs: number): number {
  const seconds = Math.max(0, durationMs) / 1000
  return Math.round(((videoBitrateFor(width, height) + EXPORT_AUDIO_BITRATE) * seconds) / 8)
}

/**
 * Size choices for a film whose first clip is `source`. Smaller presets are
 * listed only when they actually shrink the frame, so a 720p film offers
 * Full and 480p, and a tiny one offers just Full.
 */
export function exportSizeOptions(
  source: { width?: number; height?: number },
  orientation: ProjectOrientation | undefined,
  durationMs: number,
): ExportSizeOption[] {
  const sourceWidth = source.width ?? 0
  const sourceHeight = source.height ?? 0
  const full = pickOutputSize(sourceWidth, sourceHeight, orientation)
  const fullLongEdge = Math.max(full.width, full.height)
  return EXPORT_SIZE_IDS.filter(
    (id) => id === 'full' || EXPORT_SIZE_LONG_EDGE[id] < fullLongEdge,
  ).map((id) => {
    const dims =
      id === 'full'
        ? full
        : pickOutputSize(sourceWidth, sourceHeight, orientation, EXPORT_SIZE_LONG_EDGE[id])
    return { id, ...dims, estimatedBytes: estimateExportBytes(dims.width, dims.height, durationMs) }
  })
}

/** The preset that will actually apply: a remembered size this film is
 * already at or under renders as Full. */
export function effectiveExportSize(
  preferred: ExportSize,
  options: readonly Pick<ExportSizeOption, 'id'>[],
): ExportSize {
  return options.some((option) => option.id === preferred) ? preferred : 'full'
}

/** "1080p — sharpest" for the selected option's caption. */
export function exportSizeCaption(option: Pick<ExportSizeOption, 'id' | 'width' | 'height'>): string {
  return `${Math.min(option.width, option.height)}p — ${EXPORT_SIZE_HINT[option.id]}`
}
