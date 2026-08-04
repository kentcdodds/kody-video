import { isMediaElementFailure } from "./export/media-error.js";
import { measureBlobDuration, pickRecordingMimeType } from "./media.js";
/** Ignore accidental taps shorter than this — they can't produce a real clip. */
const MIN_TAKE_MS = 120;
function stopSessionTracks(session) {
    session.stream.getTracks().forEach((track) => {
        track.stop();
    });
}
export class HoldRecorder {
    session = null;
    stopping = false;
    get isRecording() {
        return this.session?.recorder.state === 'recording';
    }
    /** @returns true when a new recording actually started */
    start(stream) {
        if (this.isRecording || this.stopping)
            return false;
        const settings = stream.getVideoTracks()[0]?.getSettings();
        const clones = stream.getTracks().map((track) => track.clone());
        const recordStream = new MediaStream(clones);
        let recorder;
        try {
            const preferredMime = pickRecordingMimeType();
            recorder = preferredMime
                ? new MediaRecorder(recordStream, {
                    mimeType: preferredMime,
                    videoBitsPerSecond: 3_500_000,
                    audioBitsPerSecond: 192_000,
                })
                : new MediaRecorder(recordStream);
            const session = {
                recorder,
                stream: recordStream,
                chunks: [],
                mimeType: recorder.mimeType || preferredMime || 'video/webm',
                startedAt: performance.now(),
                trackWidth: settings?.width,
                trackHeight: settings?.height,
            };
            recorder.ondataavailable = (event) => {
                if (event.data.size > 0)
                    session.chunks.push(event.data);
            };
            recorder.start(250);
            this.session = session;
            return true;
        }
        catch {
            // Constructor/start can throw (unsupported params, dead tracks) —
            // the clones must not outlive the failed attempt.
            recordStream.getTracks().forEach((track) => {
                track.stop();
            });
            return false;
        }
    }
    stop() {
        const session = this.session;
        if (!session || session.recorder.state === 'inactive') {
            if (session)
                stopSessionTracks(session);
            this.session = null;
            this.stopping = false;
            return Promise.resolve(null);
        }
        this.stopping = true;
        const wallClockMs = Math.max(0, Math.round(performance.now() - session.startedAt));
        const finishSession = () => {
            stopSessionTracks(session);
            if (this.session === session) {
                this.session = null;
                this.stopping = false;
            }
        };
        return new Promise((resolve, reject) => {
            session.recorder.onstop = () => {
                finishSession();
                const blob = new Blob(session.chunks, { type: session.mimeType });
                const width = session.trackWidth;
                const height = session.trackHeight;
                if (blob.size === 0 || wallClockMs < MIN_TAKE_MS) {
                    resolve(null);
                    return;
                }
                // The blob's real duration is shorter than wall clock (encoder start
                // latency); trims and export math must use the media duration.
                void measureBlobDuration(blob)
                    .then((measuredMs) => {
                    resolve({
                        blob,
                        mimeType: session.mimeType || blob.type || 'video/webm',
                        durationMs: measuredMs > 0 ? measuredMs : wallClockMs,
                        width,
                        height,
                    });
                })
                    .catch((error) => {
                    // A media-element failure means the browser cannot decode this
                    // take at all — keeping it would only fail again at export.
                    // Timeouts still fall back to wall-clock (streamy WebM).
                    if (isMediaElementFailure(error)) {
                        resolve(null);
                        return;
                    }
                    resolve({
                        blob,
                        mimeType: session.mimeType || blob.type || 'video/webm',
                        durationMs: wallClockMs,
                        width,
                        height,
                    });
                });
            };
            session.recorder.onerror = () => {
                finishSession();
                reject(new Error('Recording failed'));
            };
            session.recorder.stop();
        });
    }
    cancel() {
        const session = this.session;
        this.session = null;
        this.stopping = false;
        if (!session)
            return;
        // Stale events from this session must only clean up after themselves.
        session.recorder.ondataavailable = null;
        session.recorder.onstop = () => stopSessionTracks(session);
        session.recorder.onerror = () => stopSessionTracks(session);
        if (session.recorder.state !== 'inactive') {
            try {
                session.recorder.stop();
                return;
            }
            catch {
                // Fall through — stop the clones directly.
            }
        }
        stopSessionTracks(session);
    }
}
