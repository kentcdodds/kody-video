/**
 * Cloudflare Pages Function: verify a Stripe Checkout session for the
 * Kody Video Plus purchase. Accepts a checkout session id or a short
 * restore code minted by the device that already has Plus.
 */

import { handleVerifyPurchaseRequest, type PurchaseHttpEnv } from '../../src/lib/purchase-http'

interface PagesContext {
  request: Request
  env: PurchaseHttpEnv
}

export async function onRequestGet(context: PagesContext): Promise<Response> {
  return handleVerifyPurchaseRequest(context.request, context.env)
}
