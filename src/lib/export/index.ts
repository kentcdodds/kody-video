import type { ClipRecord } from '../types'
import { exportRealtime } from './encode-realtime'
import { exportWithWebCodecs, supportsWebCodecsExport } from './encode-webcodecs'
import { planExport } from './plan'
import {
  loadWatermarkImage,
  reportSilentExportAudio,
  resetAudioDiagnostics,
  type ExportResult,
} from './shared'

export type { ExportResult } from './shared'
export { planExport, type ExportPlan, type PlannedSegment } from './plan'

export interface ExportOptions {
  onProgress?: (ratio: number) => void
  /**
   * AudioContext created from the user's tap. Only used by the realtime
   * fallback engine (WebCodecs does not need a live audio graph).
   */
  audioContext?: AudioContext
  /**
   * Visible canvas to mirror the frame currently being encoded onto
   * (sampled, not every frame). Resolved lazily so the overlay can mount
   * after the export starts.
   */
  getPreviewCanvas?: () => HTMLCanvasElement | null
  /** Stamp the Kody Video mark on frames (default true; off after purchase). */
  watermark?: boolean
}

/**
 * Stitch a project's clips into one shareable video file.
 * Prefers the frame-accurate WebCodecs engine (MP4 or WebM output) and falls
 * back to the realtime canvas + MediaRecorder stitcher elsewhere.
 */
export async function exportProject(
  clips: ClipRecord[],
  options: ExportOptions = {},
): Promise<ExportResult> {
  const plan = planExport(clips)
  if (plan.segments.length === 0) {
    throw new Error('Nothing to export yet — record a clip first')
  }

  const watermarkImage = options.watermark === false ? null : await loadWatermarkImage()

  resetAudioDiagnostics()
  if (supportsWebCodecsExport()) {
    try {
      const result = await exportWithWebCodecs(
        plan,
        options.onProgress,
        options.getPreviewCanvas,
        watermarkImage,
      )
      reportSilentExportAudio({ engine: 'webcodecs', outputMime: result.mimeType })
      return result
    } catch (error) {
      console.warn('WebCodecs export failed; falling back to realtime stitcher', error)
      resetAudioDiagnostics()
    }
  }

  const result = await exportRealtime(plan, {
    audioContext: options.audioContext,
    onProgress: options.onProgress,
    getPreviewCanvas: options.getPreviewCanvas,
    watermarkImage,
  })
  reportSilentExportAudio({ engine: 'realtime', outputMime: result.mimeType })
  return result
}
