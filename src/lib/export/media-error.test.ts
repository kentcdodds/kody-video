import { describe, expect, it } from 'vitest'
import {
  isMediaElementFailure,
  MediaElementFailureError,
  mediaErrorDetail,
} from './media-error'

describe('mediaErrorDetail', () => {
  it('returns empty when the element has no MediaError', () => {
    expect(mediaErrorDetail({})).toBe('')
    expect(mediaErrorDetail({ error: null })).toBe('')
  })

  it('formats known MediaError codes with optional message', () => {
    expect(mediaErrorDetail({ error: { code: 4 } })).toBe(' (MEDIA_ERR_SRC_NOT_SUPPORTED)')
    expect(
      mediaErrorDetail({
        error: { code: 3, message: 'PIPELINE_ERROR_DECODE' },
      }),
    ).toBe(' (MEDIA_ERR_DECODE: PIPELINE_ERROR_DECODE)')
  })
})

describe('isMediaElementFailure', () => {
  it('matches the typed media-failure marker only', () => {
    expect(
      isMediaElementFailure(new MediaElementFailureError('loadedmetadata', {})),
    ).toBe(true)
    expect(
      isMediaElementFailure(
        new MediaElementFailureError('loadedmetadata', {
          error: { code: 3, message: 'PIPELINE_ERROR_DECODE' },
        }),
      ),
    ).toBe(true)
    expect(isMediaElementFailure(new Error('Media failed while waiting for "loadedmetadata"'))).toBe(
      false,
    )
    expect(isMediaElementFailure(new Error('Timed out waiting for media "loadedmetadata"'))).toBe(
      false,
    )
  })
})
