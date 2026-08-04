import { reportError } from "../error-reporting.js";
import { exportRealtime } from "./encode-realtime.js";
import { exportWithWebCodecs, supportsWebCodecsExport } from "./encode-webcodecs.js";
import { sweepExportCache, withExportCacheReserved } from "./export-cache.js";
import { planExport } from "./plan.js";
import { AUDIO_SILENCE_PEAK, decodedAudioMaxPeak, loadWatermarkImage, measureBlobAudioPeak, reportBlackExportVideo, reportSilentExportAudio, resetAudioDiagnostics, resetVideoDiagnostics, } from "./shared.js";
export { planExport } from "./plan.js";
/**
 * Stitch a project's clips into one shareable video file.
 * Prefers the frame-accurate WebCodecs engine (MP4 or WebM output) and falls
 * back to the realtime canvas + MediaRecorder stitcher elsewhere.
 */
export async function exportProject(clips, options = {}) {
    const plan = planExport(clips);
    if (plan.segments.length === 0) {
        throw new Error('Nothing to export yet — record a clip first');
    }
    const watermarkImage = options.watermark === false ? null : await loadWatermarkImage();
    // Reclaim stale cache (old temp files, the clips zip, an orphaned last
    // export) before writing a new potentially-huge file. The current last
    // export survives — it's still the recovery net if this export fails.
    await sweepExportCache().catch(() => undefined);
    // Reserved for the whole encode: the streaming temp file has no metadata
    // reference yet, and a sweep or "clear cached exports" from another tab
    // must not delete it mid-write.
    return withExportCacheReserved(() => runExport(plan, options, watermarkImage));
}
async function runExport(plan, options, watermarkImage) {
    resetAudioDiagnostics();
    resetVideoDiagnostics();
    if (supportsWebCodecsExport()) {
        try {
            const result = await exportWithWebCodecs(plan, options.onProgress, options.getPreviewCanvas, watermarkImage);
            reportSilentExportAudio({ engine: 'webcodecs', outputMime: result.mimeType });
            reportBlackExportVideo({ engine: 'webcodecs', outputMime: result.mimeType });
            // A mux/encode fault produces a silent file with no error at any
            // stage. Verify what was actually written; the realtime engine muxes
            // through MediaRecorder (platform-native), so both a provably silent
            // output AND an output this device cannot decode at all mean fall
            // back, not fail.
            const verification = await verifyOutputAudio(result, 'webcodecs');
            if (verification === 'silent' || verification === 'undecodable') {
                throw new Error(`WebCodecs export audio ${verification} — re-exporting`);
            }
            return result;
        }
        catch (error) {
            console.warn('WebCodecs export failed; falling back to realtime stitcher', error);
            resetAudioDiagnostics();
            resetVideoDiagnostics();
        }
    }
    const result = await exportRealtime(plan, {
        audioContext: options.audioContext,
        onProgress: options.onProgress,
        getPreviewCanvas: options.getPreviewCanvas,
        watermarkImage,
    });
    reportSilentExportAudio({ engine: 'realtime', outputMime: result.mimeType });
    reportBlackExportVideo({ engine: 'realtime', outputMime: result.mimeType });
    await verifyOutputAudio(result, 'realtime');
    return result;
}
/**
 * Output-side audio check: decodes the finished file and compares against
 * the decoded inputs. 'silent' only when the inputs audibly had signal but
 * the output does not — that combination always indicates an encode/mux
 * fault, never a quiet recording.
 */
async function verifyOutputAudio(result, engine) {
    const inputPeak = decodedAudioMaxPeak();
    if (inputPeak < AUDIO_SILENCE_PEAK)
        return 'unknown';
    const measured = await measureBlobAudioPeak(result.blob);
    if (measured.peak === null) {
        // Verification is blind here — report so remote failures on
        // decode-limited platforms are still attributable. A file too large to
        // decode is genuinely unknown; a file this very device REFUSES to
        // decode right after writing it is evidence of a malformed track.
        reportError(new Error('Export output audio could not be verified'), 'export-audio-verify', {
            engine,
            outputMime: result.mimeType,
            failure: measured.failure ?? 'unknown',
            inputPeak: Number(inputPeak.toFixed(4)),
        });
        return measured.failure === 'too large to verify' ? 'unknown' : 'undecodable';
    }
    if (measured.peak >= AUDIO_SILENCE_PEAK)
        return 'ok';
    reportError(new Error('Export output audio is silent despite audible clip audio (encode/mux fault)'), 'export-audio-output', {
        engine,
        outputMime: result.mimeType,
        outputPeak: Number(measured.peak.toFixed(4)),
        inputPeak: Number(inputPeak.toFixed(4)),
    });
    return 'silent';
}
