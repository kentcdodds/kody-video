import { afterEach, describe, expect, it } from 'vitest'
import {
  contentExtentX,
  contentExtentY,
  contentX,
  contentY,
  resetShellRotationForTests,
  rotationForLock,
  setShellRotation,
  shellRotation,
} from './shell-rotation'

afterEach(() => {
  resetShellRotationForTests()
})

/**
 * A rect as the browser reports it for an element inside the rotated shell:
 * the shell's own width runs along the VIEWPORT's vertical axis (and vice
 * versa), so a wide strip measures tall.
 */
const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  new DOMRect(left, top, width, height)

describe('rotationForLock', () => {
  it('leaves the shell alone while the device already matches the lock', () => {
    expect(rotationForLock('portrait', false, 0)).toBe(0)
    expect(rotationForLock('landscape', true, 90)).toBe(0)
    expect(rotationForLock('landscape', true, 270)).toBe(0)
  })

  it('undoes the OS turn when the device is held the wrong way', () => {
    // Phone turned counter-clockwise (angle 90): the OS rotated the layout
    // one quarter turn, so the shell takes it back.
    expect(rotationForLock('portrait', true, 90)).toBe(-90)
    expect(rotationForLock('portrait', true, 270)).toBe(90)
    // Same for a landscape film held upright — the other direction of the
    // same mismatch.
    expect(rotationForLock('landscape', false, 90)).toBe(-90)
    expect(rotationForLock('landscape', false, 270)).toBe(90)
  })

  it('still turns a mismatch the device reports as its natural hold', () => {
    // A naturally-landscape tablet showing a portrait film (angle 0), or a
    // phone that reports 180: there is no OS turn to undo, but the locked
    // shape must survive anyway.
    expect(rotationForLock('portrait', true, 0)).toBe(90)
    expect(rotationForLock('landscape', false, 180)).toBe(-90)
  })

  it('tolerates the fractional/negative angles some browsers report', () => {
    expect(rotationForLock('portrait', true, 90.0001)).toBe(-90)
    expect(rotationForLock('portrait', true, -90)).toBe(90)
    expect(rotationForLock('portrait', true, 450)).toBe(-90)
  })
})

describe('setShellRotation', () => {
  it('exposes the rotation to CSS and clears it again', () => {
    setShellRotation(90)
    expect(document.documentElement.dataset.rotate).toBe('cw')
    setShellRotation(-90)
    expect(document.documentElement.dataset.rotate).toBe('ccw')
    expect(shellRotation()).toBe(-90)
    setShellRotation(0)
    expect('rotate' in document.documentElement.dataset).toBe(false)
  })
})

describe('content coordinates', () => {
  it('are the client coordinates while the shell follows the device', () => {
    expect(contentX({ clientX: 30, clientY: 200 })).toBe(30)
    expect(contentY({ clientX: 30, clientY: 200 })).toBe(200)
    const extent = contentExtentX(rect(10, 40, 300, 60))
    expect(extent).toEqual({ start: 10, end: 310, size: 300 })
    expect(contentExtentY(rect(10, 40, 300, 60))).toEqual({ start: 40, end: 100, size: 60 })
  })

  for (const rotation of [90, -90] as const) {
    describe(`rotated ${rotation}deg`, () => {
      it('measures a strip along the shell axis it was laid out on', () => {
        setShellRotation(rotation)
        // A 300x60 strip in the rotated shell is reported 60 wide, 300 tall.
        const strip = rect(200, 40, 60, 300)
        expect(contentExtentX(strip).size).toBe(300)
        expect(contentExtentY(strip).size).toBe(60)
      })

      it('keeps a drag along the shell axis pointing the same way', () => {
        setShellRotation(rotation)
        const strip = rect(200, 40, 60, 300)
        const track = contentExtentX(strip)
        // Walking the strip from its start to its end: the finger travels
        // down the viewport under 90deg and up it under -90deg, but the
        // fraction along the strip only ever grows.
        const fractions = [40, 115, 190, 265, 340].map((clientY) => {
          const point = { clientX: 230, clientY: rotation === 90 ? clientY : 380 - clientY }
          return (contentX(point) - track.start) / track.size
        })
        expect(fractions).toEqual([0, 0.25, 0.5, 0.75, 1])
      })

      it('keeps "up the stage" up the stage for drag-to-zoom', () => {
        setShellRotation(rotation)
        const stage = rect(100, 0, 300, 600)
        const extent = contentExtentY(stage)
        // The stage's top edge, and a point a quarter of the way down it.
        const top = rotation === 90 ? { clientX: 400, clientY: 0 } : { clientX: 100, clientY: 0 }
        const quarter =
          rotation === 90 ? { clientX: 325, clientY: 0 } : { clientX: 175, clientY: 0 }
        expect(contentY(top)).toBe(extent.start)
        expect((contentY(quarter) - extent.start) / extent.size).toBe(0.25)
      })
    })
  }
})
