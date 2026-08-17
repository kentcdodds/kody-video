import { describe, expect, it } from 'vitest'
import {
  clipCanvasFit,
  clipFit,
  clipFitBadge,
  clipMismatchesFilm,
  orientationFromSize,
} from './clip-fit'

describe('clipFit', () => {
  it('defaults to crop when unset', () => {
    expect(clipFit({})).toBe('crop')
    expect(clipFit({ fit: 'crop' })).toBe('crop')
    expect(clipFit({ fit: 'letterbox' })).toBe('letterbox')
  })

  it('maps crop to cover and letterbox to contain', () => {
    expect(clipCanvasFit({})).toBe('cover')
    expect(clipCanvasFit({ fit: 'letterbox' })).toBe('contain')
  })
})

describe('orientationFromSize', () => {
  it('returns null for missing or square sizes', () => {
    expect(orientationFromSize()).toBeNull()
    expect(orientationFromSize(0, 1080)).toBeNull()
    expect(orientationFromSize(1000, 1000)).toBeNull()
  })

  it('reads landscape and portrait from pixels', () => {
    expect(orientationFromSize(1920, 1080)).toBe('landscape')
    expect(orientationFromSize(1080, 1920)).toBe('portrait')
  })
})

describe('clipMismatchesFilm', () => {
  it('is false when size is unknown, square, or already matching', () => {
    expect(clipMismatchesFilm({}, 'portrait')).toBe(false)
    expect(clipMismatchesFilm({ width: 800, height: 800 }, 'landscape')).toBe(false)
    expect(clipMismatchesFilm({ width: 1080, height: 1920 }, 'portrait')).toBe(false)
    expect(clipMismatchesFilm({ width: 1920, height: 1080 }, 'landscape')).toBe(false)
  })

  it('is true when the clip and film disagree', () => {
    expect(clipMismatchesFilm({ width: 1920, height: 1080 }, 'portrait')).toBe(true)
    expect(clipMismatchesFilm({ width: 1080, height: 1920 }, 'landscape')).toBe(true)
  })
})

describe('clipFitBadge', () => {
  it('is hidden when the clip already matches the film', () => {
    expect(clipFitBadge({ width: 1080, height: 1920 }, 'portrait')).toBeNull()
    expect(clipFitBadge({ width: 1920, height: 1080, fit: 'letterbox' }, 'landscape')).toBeNull()
  })

  it('shows crop by default and letterbox when chosen', () => {
    expect(clipFitBadge({ width: 1920, height: 1080 }, 'portrait')).toBe('crop')
    expect(clipFitBadge({ width: 1920, height: 1080, fit: 'letterbox' }, 'portrait')).toBe(
      'letterbox',
    )
  })
})
