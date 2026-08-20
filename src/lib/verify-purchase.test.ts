import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleVerifyPurchaseRequest, handleRestoreCodesRequest } from './purchase-http'
import { PRODUCTION_PAYMENT_LINK_ID } from './purchase-session'
import { memorySyncKv } from './sync-rooms'

const PLINK = PRODUCTION_PAYMENT_LINK_ID

function stripeResponds(session: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(session), { status }))
}

async function body(response: Response) {
  return (await response.json()) as { unlocked?: boolean; error?: string; code?: string; sessionId?: string }
}

function env(kv = memorySyncKv()) {
  return { STRIPE_SECRET_KEY: 'rk_test_x', SYNC_ROOMS: kv }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('verify-purchase function', () => {
  const url = 'https://kody.video/api/verify-purchase?session_id=cs_live_abc123'

  it('returns 503 when the secret is not configured', async () => {
    const response = await handleVerifyPurchaseRequest(new Request(url), {})
    expect(response.status).toBe(503)
    expect((await body(response)).unlocked).toBe(false)
  })

  it('rejects malformed session ids without calling Stripe', async () => {
    const fetchSpy = vi.fn()
    const response = await handleVerifyPurchaseRequest(
      new Request('https://x.dev/api/verify-purchase?session_id=<script>'),
      env(),
      fetchSpy,
    )
    expect(response.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('unlocks a paid completed session for our payment link', async () => {
    const fetchSpy = stripeResponds({
      status: 'complete',
      payment_status: 'paid',
      payment_link: PLINK,
    })
    const response = await handleVerifyPurchaseRequest(new Request(url), env(), fetchSpy)
    expect(response.status).toBe(200)
    const json = await body(response)
    expect(json.unlocked).toBe(true)
    expect(json.sessionId).toBe('cs_live_abc123')
  })

  it('unlocks a 100%-off promo checkout (no_payment_required)', async () => {
    const fetchSpy = stripeResponds({
      status: 'complete',
      payment_status: 'no_payment_required',
      payment_link: PLINK,
    })
    const response = await handleVerifyPurchaseRequest(new Request(url), env(), fetchSpy)
    expect((await body(response)).unlocked).toBe(true)
  })

  it('rejects sessions from other payment links', async () => {
    const fetchSpy = stripeResponds({
      status: 'complete',
      payment_status: 'paid',
      payment_link: 'plink_other',
    })
    const response = await handleVerifyPurchaseRequest(new Request(url), env(), fetchSpy)
    expect(response.status).toBe(403)
    expect((await body(response)).unlocked).toBe(false)
  })

  it('rejects incomplete or unpaid sessions', async () => {
    const fetchSpy = stripeResponds({
      status: 'open',
      payment_status: 'unpaid',
      payment_link: PLINK,
    })
    const response = await handleVerifyPurchaseRequest(new Request(url), env(), fetchSpy)
    expect(response.status).toBe(403)
  })

  it('maps unknown sessions to 404', async () => {
    const fetchSpy = stripeResponds({ error: { type: 'invalid_request_error' } }, 404)
    const response = await handleVerifyPurchaseRequest(new Request(url), env(), fetchSpy)
    expect(response.status).toBe(404)
  })
})

describe('restore codes', () => {
  it('mints a code for a verified session and redeems it', async () => {
    const kv = memorySyncKv()
    const rooms = env(kv)
    const fetchSpy = stripeResponds({
      status: 'complete',
      payment_status: 'paid',
      payment_link: PLINK,
    })
    const minted = await handleRestoreCodesRequest(
      new Request('https://kody.video/api/restore-codes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_live_abc123' }),
      }),
      rooms,
      fetchSpy,
    )
    expect(minted.status).toBe(201)
    const code = (await body(minted)).code
    expect(code).toMatch(/^[A-Z2-9]{6}$/)

    const redeemed = await handleVerifyPurchaseRequest(
      new Request(`https://kody.video/api/verify-purchase?code=${code}`),
      rooms,
      fetchSpy,
    )
    expect(redeemed.status).toBe(200)
    const json = await body(redeemed)
    expect(json.unlocked).toBe(true)
    expect(json.sessionId).toBe('cs_live_abc123')
  })

  it('rejects an unknown or expired code', async () => {
    const response = await handleVerifyPurchaseRequest(
      new Request('https://kody.video/api/verify-purchase?code=ABCDEF'),
      env(),
    )
    expect(response.status).toBe(404)
    expect((await body(response)).unlocked).toBe(false)
  })

  it('does not mint a code for an unverified session', async () => {
    const fetchSpy = stripeResponds({
      status: 'open',
      payment_status: 'unpaid',
      payment_link: PLINK,
    })
    const response = await handleRestoreCodesRequest(
      new Request('https://kody.video/api/restore-codes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_live_abc123' }),
      }),
      env(),
      fetchSpy,
    )
    expect(response.status).toBe(403)
    expect((await body(response)).code).toBeUndefined()
  })
})
