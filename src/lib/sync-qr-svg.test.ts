import { describe, expect, it } from 'vitest'
import { qrSvgDataUrl, qrSvgMarkup } from './sync-qr-svg'

describe('qrSvgMarkup', () => {
  it('emits an SVG with a viewBox so it can scale in CSS', () => {
    const svg = qrSvgMarkup('https://kody.video/receive/AB3K9Q')
    expect(svg).toContain('<svg')
    expect(svg).toMatch(/viewBox="/)
    expect(svg).toContain('#1a2824')
  })
})

describe('qrSvgDataUrl', () => {
  it('is a usable image src', () => {
    const src = qrSvgDataUrl('https://kody.video/unlocked/ABC234')
    expect(src.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(decodeURIComponent(src.slice('data:image/svg+xml;charset=utf-8,'.length))).toContain(
      '<svg',
    )
  })
})
