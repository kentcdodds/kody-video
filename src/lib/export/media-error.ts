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

/** Append browser MediaError details when an HTMLMediaElement reports failure. */
export function mediaErrorDetail(media: MediaElementLike): string {
  const err = media.error
  if (!err || typeof err.code !== 'number') return ''
  const name = MEDIA_ERR_NAMES[err.code] ?? `code ${err.code}`
  const message = typeof err.message === 'string' ? err.message.trim() : ''
  return message ? ` (${name}: ${message})` : ` (${name})`
}

/** True when loadClipVideo / waitForMediaEvent rejected on the media error path. */
export function isMediaElementFailure(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Media failed while waiting for')
}
