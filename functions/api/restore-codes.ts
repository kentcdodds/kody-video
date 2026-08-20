/**
 * Cloudflare Pages Function: mint a short-lived restore code for a verified
 * Plus checkout session. The subscribed device shows the code / QR; the new
 * device redeems it via /api/verify-purchase?code=.
 */

import { handleRestoreCodesRequest, type PurchaseHttpEnv } from '../../src/lib/purchase-http'

interface PagesContext {
  request: Request
  env: PurchaseHttpEnv
}

export async function onRequestPost(context: PagesContext): Promise<Response> {
  return handleRestoreCodesRequest(context.request, context.env)
}
