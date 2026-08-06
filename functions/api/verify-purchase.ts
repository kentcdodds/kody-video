/**
 * Cloudflare Pages Function: verify a Stripe Checkout session for the
 * Kody Video Plus purchase. The only backend surface in the app — it
 * never stores anything and never sees media; it just asks Stripe whether
 * the session really completed (including 100%-off promo checkouts).
 *
 * Requires the STRIPE_SECRET_KEY environment variable on the Pages project
 * (a restricted key with Checkout Sessions read access is enough).
 */

interface Env {
  STRIPE_SECRET_KEY?: string
  /** Optional override; defaults to the production payment link. */
  STRIPE_PAYMENT_LINK_ID?: string
}

interface PagesContext {
  request: Request
  env: Env
}

const PRODUCTION_PAYMENT_LINK_ID = 'plink_1TxcxULAQpAnsYszr2bLuqOl'
const SESSION_ID_PATTERN = /^cs_[a-zA-Z0-9_]+$/

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })
}

export async function onRequestGet(context: PagesContext): Promise<Response> {
  const { request, env } = context
  const secretKey = env.STRIPE_SECRET_KEY
  if (!secretKey) {
    return json({ unlocked: false, error: 'Purchase verification is not configured yet.' }, 503)
  }

  const sessionId = new URL(request.url).searchParams.get('session_id') ?? ''
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return json({ unlocked: false, error: 'Invalid session id.' }, 400)
  }

  const response = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    { headers: { authorization: `Bearer ${secretKey}` } },
  )
  if (response.status === 404) {
    return json({ unlocked: false, error: 'No such purchase.' }, 404)
  }
  if (!response.ok) {
    return json({ unlocked: false, error: 'Could not reach Stripe. Try again shortly.' }, 502)
  }

  const session = (await response.json()) as {
    status?: string
    payment_status?: string
    payment_link?: string
  }

  const expectedLink = env.STRIPE_PAYMENT_LINK_ID ?? PRODUCTION_PAYMENT_LINK_ID
  const complete = session.status === 'complete'
  // 100%-off promotion-code checkouts complete with 'no_payment_required'.
  const paid =
    session.payment_status === 'paid' || session.payment_status === 'no_payment_required'
  const rightProduct = session.payment_link === expectedLink

  if (complete && paid && rightProduct) {
    return json({ unlocked: true }, 200)
  }
  return json(
    { unlocked: false, error: 'This checkout session is not a completed watermark purchase.' },
    403,
  )
}
