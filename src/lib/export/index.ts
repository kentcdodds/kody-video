import { reportError } from '../error-reporting'
import type { ClipRecord, ProjectOrientation } from '../types'
import type { BackgroundAudio } from './background-audio'
import { exportRealtime } from './encode-realtime'
import { exportWithWebCodecs, supportsWebCodecsExport } from './encode-webcodecs'
import { sweepExportCache, withExportCacheReserved } from './export-cache'
import { planExport } from './plan'
import {
  AUDIO_SILENCE_PEAK,
  classifyOutputAudioPeak,
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
  /**
   * Include captured coordinates in MP4 metadata and chapter titles.
   * Default false so exports do not disclose location without an explicit
   * Plus-user opt-in.
   */
  includeLocation?: boolean
  /** Background-music playlist mixed under the clips at their per-clip
   * volumes; tracks play one after the other until the film ends. */
  background?: BackgroundAudio | null
  /** Force the output into the project's orientation. Absent = follow the
   * first clip's aspect (how every project exported before the setting). */
  orientation?: ProjectOrientation
  /**
   * Fired once when the export enters the realtime canvas + MediaRecorder
   * path (no WebCodecs, or WebCodecs failed). Lets the UI offer a backup /
   * try-elsewhere hint without waiting for the finished file.
   */
  onFallback?: () => void
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

  // Reclaim stale cache (old temp files, the clips zip, an orphaned last
  // export) before writing a new potentially-huge file. The current last
  // export survives — it's still the recovery net if this export fails.
  await sweepExportCache().catch(() => undefined)

  // Reserved for the whole encode: the streaming temp file has no metadata
  // reference yet, and a sweep or "clear cached exports" from another tab
  // must not delete it mid-write.
  return withExportCacheReserved(() => runExport(plan, options, watermarkImage))
}

async function runExport(
  plan: ReturnType<typeof planExport>,
  options: ExportOptions,
  watermarkImage: Awaited<ReturnType<typeof loadWatermarkImage>> | null,
): Promise<ExportResult> {
  resetAudioDiagnostics()
  resetVideoDiagnostics()
  if (supportsWebCodecsExport()) {
    try {
      const result = await exportWithWebCodecs(
        plan,
        options.onProgress,
        options.getPreviewCanvas,
        watermarkImage,
        options.background,
        options.orientation,
        options.includeLocation === true,
      )
      reportSilentExportAudio({ engine: 'webcodecs', outputMime: result.mimeType })
      reportBlackExportVideo({ engine: 'webcodecs', outputMime: result.mimeType })
      // A mux/encode fault produces a silent file with no error at any
      // stage. Verify what was actually written; the realtime engine muxes
      // through MediaRecorder (platform-native), so both a provably silent
      // output AND an output this device cannot decode at all mean fall
      // back, not fail.
      const verification = await verifyOutputAudio(result, 'webcodecs')
      if (verification === 'silent' || verification === 'undecodable') {
        throw new Error(`WebCodecs export audio ${verification} — re-exporting`)
      }
      return result
    } catch (error) {
      console.warn('WebCodecs export failed; falling back to realtime stitcher', error)
      // Keep the decode-failure report gate: both engines share decodeClipAudio,
      // and a second Sentry event for the same export is just noise (Bugbot).
      resetAudioDiagnostics({ retainFailureReport: true })
      resetVideoDiagnostics()
    }
  }

  options.onFallback?.()
  const result = await exportRealtime(plan, {
    audioContext: options.audioContext,
    onProgress: options.onProgress,
    getPreviewCanvas: options.getPreviewCanvas,
    watermarkImage,
    background: options.background,
    orientation: options.orientation,
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
 * fault, never a quiet recording.
 */
async function verifyOutputAudio(
  result: ExportResult,
  engine: 'webcodecs' | 'realtime',
): Promise<'ok' | 'silent' | 'undecodable' | 'unknown'> {
  const inputPeak = decodedAudioMaxPeak()
  if (inputPeak < AUDIO_SILENCE_PEAK) return 'unknown'
  const measured = await measureBlobAudioPeak(result.blob)
  if (measured.peak === null) {
    // Verification is blind here — report so remote failures on
    // decode-limited platforms are still attributable. A file too large to
    // decode is genuinely unknown; a file this very device REFUSES to
    // decode right after writing it is evidence of a malformed track.
    reportError(
      new Error('Export output audio could not be verified'),
      'export-audio-verify',
      {
        engine,
        outputMime: result.mimeType,
        failure: measured.failure ?? 'unknown',
        inputPeak: Number(inputPeak.toFixed(4)),
      },
    )
    return measured.failure === 'too large to verify' ? 'unknown' : 'undecodable'
  }
  const verdict = classifyOutputAudioPeak(inputPeak, measured.peak)
  if (verdict !== 'silent') return verdict
  reportError(
    new Error('Export output audio is silent despite audible clip audio (encode/mux fault)'),
    'export-audio-output',
    {
      engine,
      outputMime: result.mimeType,
      outputPeak: Number(measured.peak.toFixed(4)),
      inputPeak: Number(inputPeak.toFixed(4)),
    },
  )
  return 'silent'
}
