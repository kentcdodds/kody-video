import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny';
import { reportError } from '../error-reporting.js';
import { isMediaElementFailure, MediaElementFailureError } from './media-error.js';
/**
 * Backoff between loadClipVideo retries. Hardware decoder slots (camera,
 * editor preview, a prior failed open) often take a few hundred ms to free
 * on Android and iOS WebKit — which can report the race as
 * MEDIA_ERR_SRC_NOT_SUPPORTED even for a blob that played moments earlier.
 */
const MEDIA_LOAD_RETRY_DELAYS_MS = [200, 500, 1000, 2000];
/**
 * Attach diagnostic detail (engine, clip index, load purpose) to an error
 * on its way up — remote export failures are undebuggable without knowing
 * WHICH clip and WHICH code path rejected.
 */
export function tagExportError(error, detail) {
    if (error && typeof error === 'object') {
        const target = error;
        target.exportDetail = { ...target.exportDetail, ...detail };
    }
    return error;
}
/**
 * Prefer the clip's recorded MIME type when the Blob's type is missing,
 * generic, or disagrees. Safari rejects object URLs typed as
 * `application/octet-stream` with MEDIA_ERR_SRC_NOT_SUPPORTED.
 */
export function blobForPlayback(blob, mimeType) {
    const preferred = (mimeType || '').trim();
    if (!preferred || preferred === blob.type)
        return blob;
    return new Blob([blob], { type: preferred });
}
/**
 * Load a clip blob into an off-DOM video element and resolve its real
 * duration. MediaRecorder WebM blobs report `Infinity` until you seek far
 * past the end, so that dance is handled here.
 *
 * Retries on media-element failure: Android/iOS often reject the first open
 * when a just-unmounted preview/camera still holds a decoder slot.
 */
export async function loadClipVideo(blob, timeoutMs = 8000, mimeType) {
    const playable = blobForPlayback(blob, mimeType);
    let lastError;
    for (let attempt = 0; attempt <= MEDIA_LOAD_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
            return await loadClipVideoOnce(playable, timeoutMs);
        }
        catch (error) {
            lastError = error;
            if (!isMediaElementFailure(error))
                throw error;
            const delay = MEDIA_LOAD_RETRY_DELAYS_MS[attempt];
            if (delay === undefined)
                break;
            await wait(delay);
        }
    }
    throw lastError;
}
async function loadClipVideoOnce(blob, timeoutMs) {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', 'true');
    const release = () => {
        try {
            video.pause();
        }
        catch {
            // already released
        }
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
    };
    try {
        // Attach the listener before assigning src/load so a synchronous
        // loadedmetadata cannot slip past (WebKit sometimes fires promptly for
        // already-buffered blob URLs).
        const metadataReady = waitForMediaEvent(video, 'loadedmetadata', timeoutMs);
        video.src = url;
        // Explicit load() helps WebKit pick up a freshly assigned blob URL after
        // a prior media element on the same page was torn down.
        video.load();
        await metadataReady;
        let durationSec = video.duration;
        if (!Number.isFinite(durationSec) || durationSec <= 0) {
            // Force Chromium to compute the duration of a streamed WebM.
            video.currentTime = Number.MAX_SAFE_INTEGER;
            await waitForCondition(() => Number.isFinite(video.duration) && video.duration > 0, timeoutMs);
            durationSec = video.duration;
            video.currentTime = 0;
            await waitForMediaEvent(video, 'seeked', 2000).catch(() => undefined);
        }
        await waitForCondition(() => video.videoWidth > 0 && video.videoHeight > 0, timeoutMs);
        return {
            video,
            mediaDurationMs: Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : 0,
            release,
        };
    }
    catch (error) {
        release();
        throw error;
    }
}
export function waitForMediaEvent(target, event, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out waiting for media "${event}"`));
        }, timeoutMs);
        const onOk = () => {
            cleanup();
            resolve();
        };
        const onErr = () => {
            cleanup();
            reject(new MediaElementFailureError(event, target));
        };
        const cleanup = () => {
            window.clearTimeout(timer);
            target.removeEventListener(event, onOk);
            target.removeEventListener('error', onErr);
        };
        target.addEventListener(event, onOk, { once: true });
        target.addEventListener('error', onErr, { once: true });
    });
}
export function waitForCondition(check, timeoutMs) {
    if (check())
        return Promise.resolve();
    return new Promise((resolve, reject) => {
        const started = performance.now();
        // Timer-based polling, not rAF: this must keep running in hidden tabs so
        // a take can finish saving after the app is backgrounded mid-recording.
        const tick = () => {
            if (check()) {
                resolve();
                return;
            }
            if (performance.now() - started > timeoutMs) {
                reject(new Error('Timed out preparing clip media'));
                return;
            }
            window.setTimeout(tick, 50);
        };
        tick();
    });
}
/**
 * Seek and wait for the frame to be ready. Resolves (never rejects) on
 * timeout because a same-position seek may not emit `seeked` everywhere.
 */
export async function seekTo(video, sec, timeoutMs = 2000) {
    const seeked = waitForMediaEvent(video, 'seeked', timeoutMs).catch(() => undefined);
    video.currentTime = sec;
    await seeked;
}
/** Draw the video into the canvas with cover fit (center crop, no bars). */
export function drawCover(ctx, video, width, height) {
    drawCoverFrom(ctx, video, video.videoWidth || width, video.videoHeight || height, width, height);
}
/** drawCover for any drawable source (VideoFrame, canvas, video element). */
export function drawCoverFrom(ctx, source, sourceWidth, sourceHeight, width, height) {
    const vw = sourceWidth || width;
    const vh = sourceHeight || height;
    const scale = Math.max(width / vw, height / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(source, (width - dw) / 2, (height - dh) / 2, dw, dh);
}
/**
 * Pick output dimensions from the first clip's real pixel size: preserve its
 * aspect ratio, cap the long edge at 1280, never upscale, keep dims even.
 */
export function pickOutputSize(sourceWidth, sourceHeight) {
    const w = sourceWidth > 0 ? sourceWidth : 720;
    const h = sourceHeight > 0 ? sourceHeight : 1280;
    const scale = Math.min(1, 1280 / Math.max(w, h));
    const even = (n) => Math.max(2, 2 * Math.round((n * scale) / 2));
    return { width: even(w), height: even(h) };
}
/** Decode a clip's audio track at the given sample rate. Null when it has none. */
let audioDecodeFailureReported = false;
let audioObservations = [];
export function resetAudioDiagnostics() {
    audioObservations = [];
}
/** Near-silence floor shared by the input and output audio diagnostics. */
export const AUDIO_SILENCE_PEAK = 0.005;
/** Loudest decoded input peak this export (0 when nothing decoded). */
export function decodedAudioMaxPeak() {
    if (audioObservations.length === 0)
        return 0;
    return Math.max(...audioObservations.map((o) => o.peak));
}
/** Fires a single tagged Sentry report when an export's audio looks wrong —
 * every clip failed to decode, or nothing above the near-silence floor. */
export function reportSilentExportAudio(context) {
    if (audioObservations.length === 0)
        return;
    const maxPeak = Math.max(...audioObservations.map((o) => o.peak));
    const allFailed = audioObservations.every((o) => o.path === 'failed');
    if (!allFailed && maxPeak >= AUDIO_SILENCE_PEAK)
        return;
    reportError(new Error(allFailed
        ? 'Export audio: every clip failed to decode'
        : 'Export audio: decoded clips are silent (mic likely recorded nothing)'), 'export-audio', {
        ...context,
        clips: audioObservations.map((o) => ({
            path: o.path,
            peak: Number(o.peak.toFixed(4)),
            mimeType: o.mimeType,
        })),
    });
}
/** The export overlay mounts just after the export starts — wait briefly.
 * Encoding into the on-DOM overlay canvas (instead of a detached one) is
 * load-bearing on Safari, which renders detached canvases as black in
 * captureStream and related paths. */
export async function waitForPreviewCanvas(getPreviewCanvas) {
    if (!getPreviewCanvas)
        return null;
    const deadline = performance.now() + 1500;
    for (;;) {
        const canvas = getPreviewCanvas();
        if (canvas?.isConnected)
            return canvas;
        if (performance.now() > deadline)
            return null;
        await wait(50);
    }
}
/** Video-side twin of the audio diagnostics: sampled encode-canvas luma.
 * A black exported video with no error is otherwise invisible remotely. */
let videoLumaSamples = [];
let videoSampleCanvas = null;
export function resetVideoDiagnostics() {
    videoLumaSamples = [];
}
/** Downsample the encode canvas to 8×8 and record the frame's mean luma. */
export function recordVideoLumaSample(source) {
    try {
        if (!videoSampleCanvas) {
            videoSampleCanvas = document.createElement('canvas');
            videoSampleCanvas.width = 8;
            videoSampleCanvas.height = 8;
        }
        const ctx = videoSampleCanvas.getContext('2d', { willReadFrequently: true });
        if (!ctx)
            return;
        ctx.drawImage(source, 0, 0, 8, 8);
        const { data } = ctx.getImageData(0, 0, 8, 8);
        let total = 0;
        for (let i = 0; i < data.length; i += 4) {
            total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }
        videoLumaSamples.push(total / (data.length / 4));
    }
    catch {
        // Sampling must never break an export.
    }
}
/** One tagged Sentry report when the export's frames were all near-black. */
export function reportBlackExportVideo(context) {
    if (videoLumaSamples.length < 3)
        return;
    const maxLuma = Math.max(...videoLumaSamples);
    if (maxLuma >= 10)
        return;
    reportError(new Error('Export video: sampled frames are all near-black'), 'export-video', {
        ...context,
        samples: videoLumaSamples.length,
        maxLuma: Number(maxLuma.toFixed(2)),
    });
}
function audioBufferPeak(buffer) {
    let peak = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
        const data = buffer.getChannelData(ch);
        const stride = Math.max(1, Math.floor(data.length / 4000));
        for (let i = 0; i < data.length; i += stride) {
            const value = Math.abs(data[i]);
            if (value > peak)
                peak = value;
        }
    }
    return peak;
}
/**
 * Decode a blob's audio track into one AudioBuffer at the requested sample
 * rate. Mediabunny demuxes and decodes (fragmented MP4, WebM/Opus, rotation
 * of containers — all one path); the result is resampled when the source
 * rate differs. Returns null when there is no decodable audio.
 */
async function decodeBlobAudio(blob, sampleRate) {
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode()))
        return null;
    const sink = new AudioBufferSink(track);
    const pieces = [];
    let sourceRate = 0;
    let channels = 1;
    let endSec = 0;
    for await (const wrapped of sink.buffers()) {
        pieces.push({ buffer: wrapped.buffer, timestamp: wrapped.timestamp });
        sourceRate = wrapped.buffer.sampleRate;
        channels = Math.max(channels, wrapped.buffer.numberOfChannels);
        endSec = Math.max(endSec, wrapped.timestamp + wrapped.duration);
    }
    if (pieces.length === 0 || sourceRate <= 0 || endSec <= 0)
        return null;
    const merged = new AudioBuffer({
        length: Math.max(1, Math.ceil(endSec * sourceRate)),
        sampleRate: sourceRate,
        numberOfChannels: channels,
    });
    // Contiguous placement: rounding each piece's timestamp independently can
    // drift ±1 sample against its neighbor, leaving one-sample overlaps/gaps
    // (audible as faint crackle). Snap to the running end when they agree.
    let runningOffset = 0;
    for (const piece of pieces) {
        const computed = Math.round(piece.timestamp * sourceRate);
        const offset = Math.abs(computed - runningOffset) <= 2 ? runningOffset : computed;
        for (let ch = 0; ch < channels; ch += 1) {
            const sourceChannel = Math.min(ch, piece.buffer.numberOfChannels - 1);
            const data = piece.buffer.getChannelData(sourceChannel);
            const available = merged.length - offset;
            if (available <= 0)
                continue;
            merged.copyToChannel(available < data.length ? data.subarray(0, available) : data, ch, offset);
        }
        // Clamp to capacity: an offset past the end must not inflate the
        // running position and pull later in-range pieces past it via the snap.
        runningOffset = Math.min(offset + piece.buffer.length, merged.length);
    }
    if (sourceRate === sampleRate)
        return merged;
    const length = Math.max(1, Math.ceil(merged.duration * sampleRate));
    const offline = new OfflineAudioContext(channels, length, sampleRate);
    const source = offline.createBufferSource();
    source.buffer = merged;
    source.connect(offline.destination);
    source.start();
    return offline.startRendering();
}
export async function decodeClipAudio(blob, sampleRate = 48000) {
    try {
        const decoded = await decodeBlobAudio(blob, sampleRate);
        if (decoded) {
            audioObservations.push({
                path: 'decoded',
                peak: audioBufferPeak(decoded),
                mimeType: blob.type,
            });
            return decoded;
        }
        audioObservations.push({ path: 'none', peak: 0, mimeType: blob.type });
        return null;
    }
    catch {
        audioObservations.push({ path: 'failed', peak: 0, mimeType: blob.type });
        if (!audioDecodeFailureReported) {
            audioDecodeFailureReported = true;
            reportError(new Error('Clip audio decode failed — export audio will be silent'), 'export-audio', {
                mimeType: blob.type,
            });
        }
        return null;
    }
}
export async function measureBlobAudioPeak(blob, sampleRate = 48000) {
    // Whole-file decode: keep memory bounded on long projects.
    if (blob.size > 120 * 1024 * 1024)
        return { peak: null, failure: 'too large to verify' };
    try {
        const decoded = await decodeBlobAudio(blob, sampleRate);
        if (decoded)
            return { peak: audioBufferPeak(decoded) };
        return { peak: null, failure: 'no decodable audio track' };
    }
    catch (error) {
        return { peak: null, failure: String(error).slice(0, 160) };
    }
}
/**
 * Load the mark stamped onto exported frames (unless the user purchased the
 * watermark removal). Best-effort: a missing asset must never fail an export.
 */
export function loadWatermarkImage() {
    return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        image.src = '/pwa-192.png';
    });
}
/** The domain shown next to the watermark mark. */
export function watermarkDomain() {
    const host = typeof location !== 'undefined' ? location.hostname : '';
    // Dev servers and IPs shouldn't end up stamped on anyone's video.
    if (!host || host === 'localhost' || /^[\d.]+$/.test(host)) {
        return 'kody.video';
    }
    return host;
}
/** Stamp the Kody Video mark + domain in the bottom-right corner of a frame. */
export function drawWatermark(ctx, image, width, height) {
    const size = Math.round(Math.min(width, height) * 0.11);
    const margin = Math.round(size * 0.35);
    const x = width - size - margin;
    const y = height - size - margin;
    const radius = Math.round(size * 0.22);
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, size, size, radius);
    ctx.clip();
    ctx.drawImage(image, x, y, size, size);
    ctx.restore();
    ctx.font = `600 ${Math.max(10, Math.round(size * 0.38))}px 'DM Sans', system-ui, sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = Math.round(size * 0.12);
    ctx.fillText(watermarkDomain(), x - Math.round(size * 0.22), y + Math.round(size / 2));
    ctx.restore();
}
/** How often the engines mirror an encoded frame to the UI preview canvas. */
export const PREVIEW_EVERY_N_FRAMES = 10;
/** Preview updates are cosmetic — ~5fps wall time is plenty. */
export const PREVIEW_INTERVAL_MS = 200;
/** Keep the mirrored preview cheap: cap its long edge well below encode size. */
const PREVIEW_MAX_EDGE = 480;
/** Mirror the engine's work canvas onto the visible preview canvas,
 * downscaled — the preview shows progress, not pixels. */
export function blitPreview(source, target) {
    if (!target)
        return;
    const scale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(source.width, source.height, 1));
    const width = Math.max(2, Math.round(source.width * scale));
    const height = Math.max(2, Math.round(source.height * scale));
    if (target.width !== width || target.height !== height) {
        target.width = width;
        target.height = height;
    }
    target.getContext('2d')?.drawImage(source, 0, 0, width, height);
}
export function wait(ms) {
    return new Promise((resolve) => {
        window.setTimeout(resolve, ms);
    });
}
