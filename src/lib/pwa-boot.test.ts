import { describe, expect, it } from 'vitest'
import {
  canPurgeCachesOnRecover,
  ORIGIN_PROBE_URL,
  shouldAwaitStylesBeforePaint,
  shouldDelayBootForLcp,
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

  it('never wipes caches when the browser reports offline', async () => {
    const fetchImpl = async () => {
      throw new Error('must not probe while offline')
    }
    expect(await canPurgeCachesOnRecover({ onLine: false, fetchImpl })).toBe(false)
  })

  it('never wipes caches when the origin probe fails (captive / no upstream)', async () => {
    expect(
      await canPurgeCachesOnRecover({
        onLine: true,
        fetchImpl: async () => {
          throw new Error('Failed to fetch')
        },
      }),
    ).toBe(false)
    expect(
      await canPurgeCachesOnRecover({
        onLine: true,
        fetchImpl: async () => new Response(null, { status: 504 }),
      }),
    ).toBe(false)
  })

  it('wipes caches only after a live same-origin probe succeeds', async () => {
    const urls: string[] = []
    expect(
      await canPurgeCachesOnRecover({
        onLine: true,
        fetchImpl: async (url) => {
          urls.push(url)
          return new Response('{"commit":"test"}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        },
      }),
    ).toBe(true)
    expect(urls).toEqual([ORIGIN_PROBE_URL])
  })
})
