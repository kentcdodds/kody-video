import { checkPurchaseSession, normalizeSessionId, type PurchaseEnv } from './purchase-session'
import { createRestoreCode, getRestoreSessionId, clientIp, requireRestoreKv } from './restore-codes'
import { jsonResponse, SyncRoomError, type SyncRoomsEnv } from './sync-rooms'

export type PurchaseHttpEnv = PurchaseEnv & SyncRoomsEnv

/**
 * GET /api/verify-purchase?session_id=cs_…  or  ?code=ABC123
 */
export async function handleVerifyPurchaseRequest(
  request: Request,
  env: PurchaseHttpEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse({ unlocked: false, error: 'Method not allowed.' }, 405)
  }

  const url = new URL(request.url)
  const rawSession = url.searchParams.get('session_id') ?? ''
  const rawCode = url.searchParams.get('code') ?? ''

  let sessionId = rawSession
  if (rawCode) {
    try {
      sessionId = await getRestoreSessionId(requireRestoreKv(env), rawCode)
    } catch (error) {
      if (error instanceof SyncRoomError) {
        return jsonResponse({ unlocked: false, error: error.message }, error.status)
      }
      return jsonResponse({ unlocked: false, error: 'Could not look up that restore code.' }, 500)
    }
  }

  const result = await checkPurchaseSession(sessionId, env, fetchImpl)
  if (!result.ok) {
    return jsonResponse({ unlocked: false, error: result.error }, result.status)
  }
  return jsonResponse({ unlocked: true, sessionId: result.sessionId }, 200)
}

/**
 * POST /api/restore-codes  { session_id }
 * Mints a short-lived code after confirming the session is a real Plus purchase.
 */
export async function handleRestoreCodesRequest(
  request: Request,
  env: PurchaseHttpEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405)
  }

  const body = (await request.json().catch(() => null)) as { session_id?: unknown } | null
  const sessionId = typeof body?.session_id === 'string' ? normalizeSessionId(body.session_id) : null
  if (!sessionId) {
    return jsonResponse({ error: 'Invalid session id.' }, 400)
  }

  const result = await checkPurchaseSession(sessionId, env, fetchImpl)
  if (!result.ok) {
    return jsonResponse({ error: result.error }, result.status)
  }

  try {
    const code = await createRestoreCode(requireRestoreKv(env), result.sessionId, clientIp(request))
    return jsonResponse({ code }, 201)
  } catch (error) {
    if (error instanceof SyncRoomError) {
      return jsonResponse({ error: error.message }, error.status)
    }
    return jsonResponse({ error: 'Could not create a restore code.' }, 500)
  }
}
