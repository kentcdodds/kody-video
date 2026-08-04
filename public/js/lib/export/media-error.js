const MEDIA_ERR_NAMES = {
    1: 'MEDIA_ERR_ABORTED',
    2: 'MEDIA_ERR_NETWORK',
    3: 'MEDIA_ERR_DECODE',
    4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
};
/** Marker so retry/discard logic does not depend on Error.message wording. */
export const MEDIA_ELEMENT_FAILURE = Symbol('kody.mediaElementFailure');
export class MediaElementFailureError extends Error {
    [MEDIA_ELEMENT_FAILURE] = true;
    /** Browser MediaError.code when present (1–4); useful for remote triage. */
    mediaErrorCode;
    constructor(event, media) {
        super(`Media failed while waiting for "${event}"${mediaErrorDetail(media)}`);
        this.name = 'MediaElementFailureError';
        const code = media.error?.code;
        if (typeof code === 'number')
            this.mediaErrorCode = code;
    }
}
/** Append browser MediaError details when an HTMLMediaElement reports failure. */
export function mediaErrorDetail(media) {
    const err = media.error;
    if (!err || typeof err.code !== 'number')
        return '';
    const name = MEDIA_ERR_NAMES[err.code] ?? `code ${err.code}`;
    const message = typeof err.message === 'string' ? err.message.trim() : '';
    return message ? ` (${name}: ${message})` : ` (${name})`;
}
/** True when waitForMediaEvent rejected on the media error path. */
export function isMediaElementFailure(error) {
    return (typeof error === 'object' &&
        error !== null &&
        MEDIA_ELEMENT_FAILURE in error &&
        error[MEDIA_ELEMENT_FAILURE] === true);
}
