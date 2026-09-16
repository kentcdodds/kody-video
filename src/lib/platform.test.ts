import { afterEach, describe, expect, it } from 'vitest'
import {
  heldDeviceOrientation,
  isStandaloneDisplay,
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

describe('isStandaloneDisplay', () => {
  const originalMatchMedia = window.matchMedia
  const originalStandalone = Object.getOwnPropertyDescriptor(navigator, 'standalone')

  afterEach(() => {
    window.matchMedia = originalMatchMedia
    if (originalStandalone) {
      Object.defineProperty(navigator, 'standalone', originalStandalone)
    } else {
      delete (navigator as { standalone?: boolean }).standalone
    }
  })

  it('is true for display-mode: standalone', () => {
    window.matchMedia = ((query: string) => {
      const media = originalMatchMedia.call(window, query)
      if (query.includes('display-mode: standalone')) {
        Object.defineProperty(media, 'matches', { configurable: true, value: true })
      }
      return media
    }) as typeof window.matchMedia
    expect(isStandaloneDisplay()).toBe(true)
  })

  it('is true for iOS navigator.standalone when the media query is false', () => {
    window.matchMedia = ((query: string) => {
      const media = originalMatchMedia.call(window, query)
      if (query.includes('display-mode: standalone')) {
        Object.defineProperty(media, 'matches', { configurable: true, value: false })
      }
      return media
    }) as typeof window.matchMedia
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true })
    expect(isStandaloneDisplay()).toBe(true)
  })

  it('is false in a regular browser tab', () => {
    window.matchMedia = ((query: string) => {
      const media = originalMatchMedia.call(window, query)
      if (query.includes('display-mode: standalone')) {
        Object.defineProperty(media, 'matches', { configurable: true, value: false })
      }
      return media
    }) as typeof window.matchMedia
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: false })
    expect(isStandaloneDisplay()).toBe(false)
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
