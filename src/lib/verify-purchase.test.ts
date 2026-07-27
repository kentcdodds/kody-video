import { afterEach, describe, expect, it, vi } from 'vitest'
import { onRequestGet } from '../../functions/api/verify-purchase'

const PLINK = 'plink_1TxcxULAQpAnsYszr2bLuqOl'

function makeContext(url: string, env: Record<string, string> = {}) {
  return { request: new Request(url), env }
}

function stripeResponds(session: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(session), { status })),
  )
}

async function body(response: Response) {
  return (await response.json()) as { unlocked: boolean; error?: string }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('verify-purchase function', () => {
  const url = 'https://kody-video.pages.dev/api/verify-purchase?session_id=cs_live_abc123'
  const env = { STRIPE_SECRET_KEY: 'rk_test_x' }

  it('returns 503 when the secret is not configured', async () => {
    const response = await onRequestGet(makeContext(url, {}))
    expect(response.status).toBe(503)
    expect((await body(response)).unlocked).toBe(false)
  })

  it('rejects malformed session ids without calling Stripe', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const response = await onRequestGet(
      makeContext('https://x.dev/api/verify-purchase?session_id=<script>', env),
    )
    expect(response.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('unlocks a paid completed session for our payment link', async () => {
    stripeResponds({ status: 'complete', payment_status: 'paid', payment_link: PLINK })
    const response = await onRequestGet(makeContext(url, env))
    expect(response.status).toBe(200)
    expect((await body(response)).unlocked).toBe(true)
  })

  it('unlocks a 100%-off promo checkout (no_payment_required)', async () => {
    stripeResponds({
      status: 'complete',
      payment_status: 'no_payment_required',
      payment_link: PLINK,
    })
    const response = await onRequestGet(makeContext(url, env))
    expect((await body(response)).unlocked).toBe(true)
  })

  it('rejects sessions from other payment links', async () => {
    stripeResponds({ status: 'complete', payment_status: 'paid', payment_link: 'plink_other' })
    const response = await onRequestGet(makeContext(url, env))
    expect(response.status).toBe(403)
    expect((await body(response)).unlocked).toBe(false)
  })

  it('rejects incomplete or unpaid sessions', async () => {
    stripeResponds({ status: 'open', payment_status: 'unpaid', payment_link: PLINK })
    const response = await onRequestGet(makeContext(url, env))
    expect(response.status).toBe(403)
  })

  it('maps unknown sessions to 404', async () => {
    stripeResponds({ error: { type: 'invalid_request_error' } }, 404)
    const response = await onRequestGet(makeContext(url, env))
    expect(response.status).toBe(404)
  })
})
