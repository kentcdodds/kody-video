/** Narrow MediaError shape so helpers stay testable outside a browser DOM. */
export interface MediaErrorLike {
  code?: number
  message?: string
}

export interface MediaElementLike {
  error?: MediaErrorLike | null
}

const MEDIA_ERR_NAMES: Record<number, string> = {
  1: 'MEDIA_ERR_ABORTED',
  2: 'MEDIA_ERR_NETWORK',
  3: 'MEDIA_ERR_DECODE',
  4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
}

/** Marker so retry/discard logic does not depend on Error.message wording. */
export const MEDIA_ELEMENT_FAILURE = Symbol('kody.mediaElementFailure')

export class MediaElementFailureError extends Error {
  readonly [MEDIA_ELEMENT_FAILURE] = true as const

  constructor(event: string, media: MediaElementLike) {
    super(`Media failed while waiting for "${event}"${mediaErrorDetail(media)}`)
    this.name = 'MediaElementFailureError'
  }
}

/** Append browser MediaError details when an HTMLMediaElement reports failure. */
export function mediaErrorDetail(media: MediaElementLike): string {
  const err = media.error
  if (!err || typeof err.code !== 'number') return ''
  const name = MEDIA_ERR_NAMES[err.code] ?? `code ${err.code}`
  const message = typeof err.message === 'string' ? err.message.trim() : ''
  return message ? ` (${name}: ${message})` : ` (${name})`
}

/** True when waitForMediaEvent rejected on the media error path. */
export function isMediaElementFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    MEDIA_ELEMENT_FAILURE in error &&
    (error as { [MEDIA_ELEMENT_FAILURE]?: unknown })[MEDIA_ELEMENT_FAILURE] === true
  )
}
