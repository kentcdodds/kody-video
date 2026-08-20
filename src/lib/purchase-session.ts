/**
 * Shared Stripe Checkout session check used by purchase verification and
 * restore-code minting. Never stores media; it only asks Stripe whether a
 * session is a completed Kody Video Plus purchase.
 */

export const PRODUCTION_PAYMENT_LINK_ID = 'plink_1TxcxULAQpAnsYszr2bLuqOl'
export const SESSION_ID_PATTERN = /^cs_[a-zA-Z0-9_]+$/

export interface PurchaseEnv {
  STRIPE_SECRET_KEY?: string
  /** Optional override; defaults to the production payment link. */
  STRIPE_PAYMENT_LINK_ID?: string
}

export type PurchaseCheck =
  | { ok: true; sessionId: string }
  | { ok: false; error: string; status: number }

interface StripeCheckoutSession {
  status?: string
  payment_status?: string
  payment_link?: string
}

export function normalizeSessionId(value: string): string | null {
  const sessionId = value.trim()
  return SESSION_ID_PATTERN.test(sessionId) ? sessionId : null
}

export async function checkPurchaseSession(
  sessionId: string,
  env: PurchaseEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<PurchaseCheck> {
  const normalized = normalizeSessionId(sessionId)
  if (!normalized) {
    return { ok: false, error: 'Invalid session id.', status: 400 }
  }

  const secretKey = env.STRIPE_SECRET_KEY
  if (!secretKey) {
    return { ok: false, error: 'Purchase verification is not configured yet.', status: 503 }
  }

  let response: Response
  try {
    response = await fetchImpl(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(normalized)}`,
      { headers: { authorization: `Bearer ${secretKey}` } },
    )
  } catch {
    return { ok: false, error: 'Could not reach Stripe. Try again shortly.', status: 502 }
  }
  if (response.status === 404) {
    return { ok: false, error: 'No such purchase.', status: 404 }
  }
  if (!response.ok) {
    return { ok: false, error: 'Could not reach Stripe. Try again shortly.', status: 502 }
  }

  let session: StripeCheckoutSession
  try {
    session = (await response.json()) as StripeCheckoutSession
  } catch {
    return { ok: false, error: 'Could not reach Stripe. Try again shortly.', status: 502 }
  }

  const expectedLink = env.STRIPE_PAYMENT_LINK_ID ?? PRODUCTION_PAYMENT_LINK_ID
  const complete = session.status === 'complete'
  // 100%-off promotion-code checkouts complete with 'no_payment_required'.
  const paid =
    session.payment_status === 'paid' || session.payment_status === 'no_payment_required'
  const rightProduct = session.payment_link === expectedLink

  if (complete && paid && rightProduct) {
    return { ok: true, sessionId: normalized }
  }
  return {
    ok: false,
    error: 'This checkout session is not a completed watermark purchase.',
    status: 403,
  }
}
