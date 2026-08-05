import { describe, expect, it } from 'vitest'
import { shouldWatermarkExports } from '../entitlement'
import { watermarkLayout } from './shared'

describe('shouldWatermarkExports', () => {
  it('stamps free-plan exports', () => {
    expect(shouldWatermarkExports({ watermarkRemoved: false })).toBe(true)
    expect(shouldWatermarkExports({})).toBe(true)
  })

  it('skips the mark after purchase by default', () => {
    expect(shouldWatermarkExports({ watermarkRemoved: true })).toBe(false)
    expect(shouldWatermarkExports({ watermarkRemoved: true, keepWatermark: false })).toBe(false)
  })

  it('keeps the mark after purchase when opted in', () => {
    expect(shouldWatermarkExports({ watermarkRemoved: true, keepWatermark: true })).toBe(true)
  })
})

describe('watermarkLayout', () => {
  it('stacks the mark above the domain, centered, in the bottom-right', () => {
    const width = 1080
    const height = 1920
    // Narrower than the mark — stack width is the mark.
    const layout = watermarkLayout(width, height, 40)
    const size = Math.round(Math.min(width, height) * 0.11)
    const margin = Math.round(size * 0.35)
    const fontSize = Math.max(10, Math.round(size * 0.38))
    const gap = Math.round(size * 0.14)

    expect(layout.size).toBe(size)
    expect(layout.fontSize).toBe(fontSize)
    // Mark sits above the text with a gap; text baseline is vertically centered
    // in the text band that ends at height - margin.
    expect(layout.markY + size + gap + fontSize).toBe(height - margin)
    expect(layout.textY).toBe(layout.markY + size + gap + fontSize / 2)
    // Shared horizontal center; group flush to the right margin.
    expect(layout.textX).toBe(layout.markX + size / 2)
    expect(layout.markX + size).toBe(width - margin)
  })

  it('widens the stack when the domain is wider than the mark', () => {
    const width = 1080
    const height = 1920
    const textWidth = 200
    const layout = watermarkLayout(width, height, textWidth)
    const size = Math.round(Math.min(width, height) * 0.11)
    const margin = Math.round(size * 0.35)
    // Group right edge is approximately the text (wider); mark stays centered on it.
    expect(Math.abs(layout.textX + textWidth / 2 - (width - margin))).toBeLessThanOrEqual(1)
    expect(layout.textX).toBe(layout.markX + size / 2)
  })
})
