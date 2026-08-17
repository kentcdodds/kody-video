import { afterEach, describe, expect, it } from 'vitest'
import {
  heldDeviceOrientation,
  setPlatformOverridesForTests,
  subscribeViewportOrientationChange,
  viewportIsLandscape,
} from './platform'

describe('viewportIsLandscape', () => {
  const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  const originalHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
  const originalMatchMedia = window.matchMedia

  afterEach(() => {
    setPlatformOverridesForTests({})
    if (originalWidth) Object.defineProperty(window, 'innerWidth', originalWidth)
    if (originalHeight) Object.defineProperty(window, 'innerHeight', originalHeight)
    window.matchMedia = originalMatchMedia
  })

  function stubViewport(width: number, height: number, cssLandscape: boolean) {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
    window.matchMedia = ((query: string) => {
      const media = originalMatchMedia.call(window, query)
      if (query.includes('orientation: landscape')) {
        Object.defineProperty(media, 'matches', { configurable: true, value: cssLandscape })
      }
      return media
    }) as typeof window.matchMedia
  }

  it('follows the layout viewport when CSS orientation is stuck', () => {
    stubViewport(844, 390, false)
    expect(viewportIsLandscape()).toBe(true)
    stubViewport(390, 844, true)
    expect(viewportIsLandscape()).toBe(false)
  })

  it('honors the test override over the window', () => {
    stubViewport(844, 390, true)
    setPlatformOverridesForTests({ viewportLandscape: false })
    expect(viewportIsLandscape()).toBe(false)
  })
})

describe('heldDeviceOrientation', () => {
  afterEach(() => {
    setPlatformOverridesForTests({})
  })

  it('is null on fine-pointer devices', () => {
    setPlatformOverridesForTests({ coarsePointer: false, viewportLandscape: true })
    expect(heldDeviceOrientation()).toBeNull()
  })

  it('reports the hold on coarse-pointer devices', () => {
    setPlatformOverridesForTests({ coarsePointer: true, viewportLandscape: true })
    expect(heldDeviceOrientation()).toBe('landscape')
    setPlatformOverridesForTests({ coarsePointer: true, viewportLandscape: false })
    expect(heldDeviceOrientation()).toBe('portrait')
  })
})

describe('subscribeViewportOrientationChange', () => {
  it('notifies on resize so a stuck CSS orientation media still updates', async () => {
    let calls = 0
    const stop = subscribeViewportOrientationChange(() => {
      calls += 1
    })
    window.dispatchEvent(new Event('resize'))
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
    stop()
    expect(calls).toBeGreaterThan(0)
  })
})
