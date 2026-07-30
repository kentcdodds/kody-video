import { reportError } from '../error-reporting'
import type { ClipRecord } from '../types'
import { exportRealtime } from './encode-realtime'
import { exportWithWebCodecs, supportsWebCodecsExport } from './encode-webcodecs'
import { planExport } from './plan'
import {
  AUDIO_SILENCE_PEAK,
  decodedAudioMaxPeak,
  loadWatermarkImage,
  measureBlobAudioPeak,
  reportBlackExportVideo,
  reportSilentExportAudio,
  resetAudioDiagnostics,
  resetVideoDiagnostics,
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
  resetVideoDiagnostics()
  if (supportsWebCodecsExport()) {
    try {
      const result = await exportWithWebCodecs(
        plan,
        options.onProgress,
        options.getPreviewCanvas,
        watermarkImage,
      )
      reportSilentExportAudio({ engine: 'webcodecs', outputMime: result.mimeType })
      reportBlackExportVideo({ engine: 'webcodecs', outputMime: result.mimeType })
      // A mux fault (e.g. an AAC track written without its decoder config)
      // produces a silent file with no error at any stage. Verify what was
      // actually written; the realtime engine muxes through MediaRecorder
      // and is immune, so silent output here means fall back, not fail.
      if ((await verifyOutputAudio(result, 'webcodecs')) === 'silent') {
        throw new Error('WebCodecs export produced silent audio')
      }
      return result
    } catch (error) {
      console.warn('WebCodecs export failed; falling back to realtime stitcher', error)
      resetAudioDiagnostics()
      resetVideoDiagnostics()
    }
  }

  const result = await exportRealtime(plan, {
    audioContext: options.audioContext,
    onProgress: options.onProgress,
    getPreviewCanvas: options.getPreviewCanvas,
    watermarkImage,
  })
  reportSilentExportAudio({ engine: 'realtime', outputMime: result.mimeType })
  reportBlackExportVideo({ engine: 'realtime', outputMime: result.mimeType })
  await verifyOutputAudio(result, 'realtime')
  return result
}

/**
 * Output-side audio check: decodes the finished file and compares against
 * the decoded inputs. 'silent' only when the inputs audibly had signal but
 * the output does not — that combination always indicates an encode/mux
 * fault, never a quiet recording. Reports to Sentry with the mux seam's
 * diagnostics so remote failures are attributable.
 */
async function verifyOutputAudio(
  result: ExportResult,
  engine: 'webcodecs' | 'realtime',
): Promise<'ok' | 'silent' | 'unknown'> {
  const inputPeak = decodedAudioMaxPeak()
  if (inputPeak < AUDIO_SILENCE_PEAK) return 'unknown'
  const outputPeak = await measureBlobAudioPeak(result.blob)
  if (outputPeak === null) return 'unknown'
  if (outputPeak >= AUDIO_SILENCE_PEAK) return 'ok'
  reportError(
    new Error('Export output audio is silent despite audible clip audio (encode/mux fault)'),
    'export-audio-output',
    {
      engine,
      outputMime: result.mimeType,
      outputPeak: Number(outputPeak.toFixed(4)),
      inputPeak: Number(inputPeak.toFixed(4)),
      ...(result.audioDiagnostics ?? {}),
    },
  )
  return 'silent'
}
