import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  dismissShowcaseBanner,
  isShowcaseBannerDismissed,
  showcaseForHostname,
} from './showcase'

describe('showcaseForHostname', () => {
  it('identifies the Remix rewrite preview domain', () => {
    const info = showcaseForHostname('remix.kody.video')
    expect(info?.edition).toBe('Remix 3 rewrite')
    expect(info?.prNumber).toBe(87)
    expect(info?.prUrl).toBe('https://github.com/kentcdodds/kody-video/pull/87')
  })

  it('returns null for production, dev, and the pages.dev migration origin', () => {
    expect(showcaseForHostname('kody.video')).toBeNull()
    expect(showcaseForHostname('localhost')).toBeNull()
    expect(showcaseForHostname('127.0.0.1')).toBeNull()
    // pages.dev keeps its own (non-showcase) migration banner.
    expect(showcaseForHostname('kody-video.pages.dev')).toBeNull()
    // The other showcases carry their banner in their own branches.
    expect(showcaseForHostname('vanilla.kody.video')).toBeNull()
    expect(showcaseForHostname('typescript.kody.video')).toBeNull()
    expect(showcaseForHostname('react.kody.video')).toBeNull()
  })
})

describe('showcase banner dismissal', () => {
  // Node test environment has no localStorage; back it with a Map.
  const backing = new Map<string, string>()

  beforeEach(() => {
    backing.clear()
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => backing.get(key) ?? null,
        setItem: (key: string, value: string) => void backing.set(key, value),
      },
    })
  })

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage
  })

  it('starts visible and stays dismissed after dismissal', () => {
    expect(isShowcaseBannerDismissed()).toBe(false)
    dismissShowcaseBanner()
    expect(isShowcaseBannerDismissed()).toBe(true)
  })
})
