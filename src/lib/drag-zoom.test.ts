import { describe, expect, it } from 'vitest'
import { dragZoomValue } from './drag-zoom'

const stage = { stageTop: 0, stageHeight: 800 }

describe('dragZoomValue', () => {
  it('reaches MAX zoom at the top of the stage regardless of press point', () => {
    for (const anchorY of [700, 400, 200]) {
      const value = dragZoomValue({ ...stage, anchorY, clientY: 0, start: 1, min: 1, max: 8 })
      expect(value).toBe(8)
    }
  })

  it('reaches MIN zoom at the bottom of the stage', () => {
    const value = dragZoomValue({
      ...stage,
      anchorY: 300,
      clientY: 800,
      start: 4,
      min: 0.5,
      max: 8,
    })
    expect(value).toBe(0.5)
  })

  it('interpolates exponentially: half the travel is the geometric midpoint', () => {
    // Press at the bottom, drag halfway up: start 1, max 16 → sqrt(16) = 4.
    const value = dragZoomValue({
      ...stage,
      anchorY: 800,
      clientY: 400,
      start: 1,
      min: 1,
      max: 16,
    })
    expect(value).toBeCloseTo(4, 5)
  })

  it('no movement means no change', () => {
    const value = dragZoomValue({ ...stage, anchorY: 400, clientY: 400, start: 2, min: 1, max: 8 })
    expect(value).toBe(2)
  })

  it('dragging down from min stays at min', () => {
    const value = dragZoomValue({ ...stage, anchorY: 100, clientY: 500, start: 1, min: 1, max: 8 })
    expect(value).toBe(1)
  })

  it('clamps beyond the stage edges', () => {
    const value = dragZoomValue({
      ...stage,
      anchorY: 400,
      clientY: -300,
      start: 1,
      min: 1,
      max: 8,
    })
    expect(value).toBe(8)
  })

  it('applies the travel floor for presses near an edge (no hair-trigger)', () => {
    // Press 10px from the top: available up-travel is floored at 20% of the
    // stage (160px), so 10px of travel must NOT already reach max.
    const value = dragZoomValue({ ...stage, anchorY: 10, clientY: 0, start: 1, min: 1, max: 8 })
    expect(value).toBeLessThan(8)
    expect(value).toBeGreaterThan(1)
  })

  it('supports sub-1x ranges (ultra-wide)', () => {
    const value = dragZoomValue({
      ...stage,
      anchorY: 200,
      clientY: 800,
      start: 1,
      min: 0.5,
      max: 8,
    })
    expect(value).toBe(0.5)
  })
})
