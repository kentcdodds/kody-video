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
      // A mux fault (broken AAC framing, a mangled sample timeline, …)
      // produces a silent file with no error at any stage. Verify what was
      // actually written; the realtime engine muxes through MediaRecorder
      // and is immune, so silent output here means fall back, not fail.
      const verification = await verifyOutputAudio(result, 'webcodecs')
      maybeReportAudioSeamDiagnostics(result, verification)
      if (verification === 'silent') {
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
  const measured = await measureBlobAudioPeak(result.blob)
  if (measured.peak === null) {
    // Verification is blind here — silence would go unnoticed. Report so
    // remote failures on decode-limited platforms are still attributable.
    reportError(
      new Error('Export output audio could not be verified'),
      'export-audio-verify',
      {
        engine,
        outputMime: result.mimeType,
        failure: measured.failure ?? 'unknown',
        inputPeak: Number(inputPeak.toFixed(4)),
        ...(result.audioDiagnostics ?? {}),
      },
    )
    return 'unknown'
  }
  if (measured.peak >= AUDIO_SILENCE_PEAK) return 'ok'
  reportError(
    new Error('Export output audio is silent despite audible clip audio (encode/mux fault)'),
    'export-audio-output',
    {
      engine,
      outputMime: result.mimeType,
      outputPeak: Number(measured.peak.toFixed(4)),
      inputPeak: Number(inputPeak.toFixed(4)),
      ...(result.audioDiagnostics ?? {}),
    },
  )
  return 'silent'
}

/** One report per session when the AAC seam had to repair encoder output —
 * WebKit's encoder quirks (ADTS framing, zeroed timestamps) are otherwise
 * invisible when the repair WORKS, and knowing they fired on a given
 * platform is what confirms the diagnosis remotely. */
let audioSeamReported = false
function maybeReportAudioSeamDiagnostics(
  result: ExportResult,
  verification: 'ok' | 'silent' | 'unknown',
): void {
  const diagnostics = result.audioDiagnostics
  if (!diagnostics) return
  const repaired = diagnostics.adtsStripped > 0 || diagnostics.timestampOverrides > 0
  if (!repaired || audioSeamReported) return
  audioSeamReported = true
  reportError(
    new Error('Export audio seam repaired encoder output (informational)'),
    'export-audio-fixup',
    { verification, outputMime: result.mimeType, ...diagnostics },
  )
}
