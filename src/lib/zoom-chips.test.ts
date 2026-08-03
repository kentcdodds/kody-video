import { describe, expect, it } from 'vitest'
import { ZOOM_CHIP_MAX, formatZoomLabel, nearestZoomLevel, zoomChipLevels } from './zoom-chips'

describe('zoomChipLevels', () => {
  it('caps the top chip while long digital ranges stay drag-reachable', () => {
    // 30× super-res mush: chips stop at the cap; drag-zoom (which reads the
    // camera range directly, not these chips) still spans the full 30×.
    expect(zoomChipLevels({ min: 1, max: 30 })).toEqual([1, 2, ZOOM_CHIP_MAX])
  })

  it('keeps modest ranges unchanged', () => {
    expect(zoomChipLevels({ min: 1, max: 8 })).toEqual([1, 2, 8])
    expect(zoomChipLevels({ min: 1, max: 2 })).toEqual([1, 2])
  })

  it('prefers a clean integer near the top', () => {
    expect(zoomChipLevels({ min: 1, max: 4.9 })).toEqual([1, 2, 4.9])
    expect(zoomChipLevels({ min: 1, max: 5.2 })).toEqual([1, 2, 5])
  })

  it('includes the sub-1× minimum of logical multi-cameras', () => {
    expect(zoomChipLevels({ min: 0.5, max: 30 })).toEqual([0.5, 1, 2, ZOOM_CHIP_MAX])
  })

  it('collapses degenerate ranges to a single chip', () => {
    expect(zoomChipLevels({ min: 1, max: 1 })).toEqual([1])
  })
})

describe('formatZoomLabel', () => {
  it('renders integers plainly and fractions with one decimal', () => {
    expect(formatZoomLabel(2)).toBe('2×')
    expect(formatZoomLabel(0.5)).toBe('0.5×')
    expect(formatZoomLabel(2.34)).toBe('2.3×')
  })
})

describe('nearestZoomLevel', () => {
  it('picks the closest chip to the current value', () => {
    expect(nearestZoomLevel([1, 2, 10], 2.3)).toBe(2)
    expect(nearestZoomLevel([1, 2, 10], 25)).toBe(10)
  })
})
