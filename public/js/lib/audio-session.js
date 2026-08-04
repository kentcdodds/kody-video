import { isIosBrowser } from './media.js';
function audioSession() {
    if (!isIosBrowser())
        return null;
    const session = navigator.audioSession;
    return session ?? null;
}
/** Call right after a mic-carrying stream is adopted. */
export function engageRecordAudioSession() {
    const session = audioSession();
    if (!session)
        return;
    try {
        session.type = 'play-and-record';
    }
    catch {
        // Unsupported value on this WebKit build — routing stays as-is.
    }
}
/** Call after the mic-carrying stream is stopped. */
export function releaseRecordAudioSession() {
    const session = audioSession();
    if (!session)
        return;
    try {
        session.type = 'playback';
        session.type = 'auto';
    }
    catch {
        // Best-effort restore.
    }
}
