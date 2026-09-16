import { describe, expect, it } from 'vitest'
import {
  shouldAwaitStylesBeforePaint,
  shouldDelayBootForLcp,
  shouldPurgeCachesOnRecover,
} from './pwa-boot'

describe('installed PWA boot policy', () => {
  it('boots the cached shell immediately in standalone (no LCP two-rAF delay)', () => {
    expect(shouldDelayBootForLcp(true)).toBe(false)
    expect(shouldDelayBootForLcp(false)).toBe(true)
  })

  it('does not hold first paint on CSS import() when installed', () => {
    expect(shouldAwaitStylesBeforePaint(true)).toBe(false)
    expect(shouldAwaitStylesBeforePaint(false)).toBe(true)
  })

  it('never wipes the service worker / Cache Storage while offline', () => {
    expect(shouldPurgeCachesOnRecover(false)).toBe(false)
    expect(shouldPurgeCachesOnRecover(true)).toBe(true)
  })
})
