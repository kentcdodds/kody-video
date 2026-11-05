import { describe, expect, it } from 'vitest'
import {
  effectiveExportSize,
  estimateExportBytes,
  exportSizeCaption,
  exportSizeOptions,
} from './export-size'

describe('exportSizeOptions', () => {
  it('offers Full, 720p and 480p for a 1080p portrait film', () => {
    const options = exportSizeOptions({ width: 1080, height: 1920 }, 'portrait', 60_000)
    expect(options.map(({ id, width, height }) => ({ id, width, height }))).toEqual([
      { id: 'full', width: 1080, height: 1920 },
      { id: '720p', width: 720, height: 1280 },
      { id: '480p', width: 480, height: 854 },
    ])
    expect(options[0]!.estimatedBytes).toBeGreaterThan(options[1]!.estimatedBytes)
    expect(options[1]!.estimatedBytes).toBeGreaterThan(options[2]!.estimatedBytes)
  })

  it('keeps landscape output landscape at smaller sizes', () => {
    const options = exportSizeOptions({ width: 1920, height: 1080 }, 'landscape', 10_000)
    expect(options.find((option) => option.id === '720p')).toMatchObject({
      width: 1280,
      height: 720,
    })
  })

  it('hides presets that would not shrink a 720p film', () => {
    const options = exportSizeOptions({ width: 720, height: 1280 }, 'portrait', 10_000)
    expect(options.map((option) => option.id)).toEqual(['full', '480p'])
  })

  it('offers only Full when the film is already small', () => {
    const options = exportSizeOptions({ width: 480, height: 854 }, 'portrait', 10_000)
    expect(options.map((option) => option.id)).toEqual(['full'])
  })
})

describe('effectiveExportSize', () => {
  it('falls back to Full when the remembered size is not offered', () => {
    expect(effectiveExportSize('720p', [{ id: 'full' }, { id: '480p' }])).toBe('full')
    expect(effectiveExportSize('480p', [{ id: 'full' }, { id: '480p' }])).toBe('480p')
  })
})

describe('estimateExportBytes', () => {
  it('sums video and audio bitrate over the duration', () => {
    // 1080p30 ≈ 9.95 Mbps video + 192 kbps audio ≈ 1.27 MB per second.
    const perSecond = estimateExportBytes(1080, 1920, 1000)
    expect(perSecond).toBeGreaterThan(1_200_000)
    expect(perSecond).toBeLessThan(1_350_000)
    expect(estimateExportBytes(1080, 1920, 0)).toBe(0)
  })
})

describe('exportSizeCaption', () => {
  it('names the short edge', () => {
    expect(exportSizeCaption({ id: '720p', width: 720, height: 1280 })).toMatch(/^720p/)
  })
})
