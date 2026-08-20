import { getDb, getSettings } from './storage'
import type { AppMeta } from './types'
import { normalizeRoomCode } from './sync-protocol'

/** Stripe Payment Link for the one-time Kody Video Plus unlock ($0.99). */
export const REMOVE_WATERMARK_LINK = 'https://buy.stripe.com/00wfZi71ibU30rk9hU2Ry07'

const SESSION_ID_PATTERN = /cs_(?:live|test)_[a-zA-Z0-9]+/

export async function isWatermarkRemoved(): Promise<boolean> {
  const settings = await getSettings()
  return settings.watermarkRemoved === true
}

export async function getPurchaseSessionId(): Promise<string | null> {
  const settings = await getSettings()
  return settings.purchaseSessionId ?? null
}

export async function markWatermarkRemoved(sessionId: string): Promise<void> {
  const db = await getDb()
  const settings = await getSettings()
  await db.put('meta', { ...settings, watermarkRemoved: true, purchaseSessionId: sessionId })
}

/**
 * Whether new exports should stamp the Kody mark.
 * Free plan: always. Plus: only when the user opted to keep it.
 */
export function shouldWatermarkExports(
  settings: Pick<AppMeta, 'watermarkRemoved' | 'keepWatermark'>,
): boolean {
  if (settings.keepWatermark === true) return true
  return settings.watermarkRemoved !== true
}

export interface VerifyResult {
  unlocked: boolean
  error?: string
  sessionId?: string
}

export type RestoreToken =
  | { kind: 'session'; value: string }
  | { kind: 'code'; value: string }

/**
 * Ask the Pages Function to confirm a Stripe Checkout session or a short
 * restore code, and persist the entitlement when it checks out.
 */
export async function verifyPurchaseSession(
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  return verifyPurchase({ kind: 'session', value: sessionId }, fetchImpl)
}

export async function verifyPurchase(
  token: RestoreToken,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  const query =
    token.kind === 'session'
      ? `session_id=${encodeURIComponent(token.value)}`
      : `code=${encodeURIComponent(token.value)}`
  try {
    const response = await fetchImpl(`/api/verify-purchase?${query}`, {
      headers: { accept: 'application/json' },
    })
    const body = (await response.json().catch(() => null)) as VerifyResult | null
    if (response.ok && body?.unlocked) {
      const sessionId = body.sessionId ?? (token.kind === 'session' ? token.value : '')
      if (sessionId) await markWatermarkRemoved(sessionId)
      return { unlocked: true, sessionId }
    }
    return {
      unlocked: false,
      error: body?.error ?? 'Could not verify the purchase. Try again shortly.',
    }
  } catch {
    return { unlocked: false, error: 'Could not verify the purchase — are you offline?' }
  }
}

export async function mintRestoreCode(
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ code: string } | { error: string }> {
  try {
    const response = await fetchImpl('/api/restore-codes', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    })
    const body = (await response.json().catch(() => null)) as {
      code?: string
      error?: string
    } | null
    if (response.ok && typeof body?.code === 'string') {
      return { code: body.code }
    }
    return { error: body?.error ?? 'Could not create a restore code. Try again shortly.' }
  } catch {
    return { error: 'Could not create a restore code — are you offline?' }
  }
}

/** Pull a checkout session id out of pasted text (receipt URL, session id, …). */
export function extractSessionId(text: string): string | null {
  const match = text.match(SESSION_ID_PATTERN)
  return match ? match[0] : null
}

export function looksLikeStripeReceipt(text: string): boolean {
  return /pay\.stripe\.com\/receipts|dashboard\.stripe\.com/i.test(text)
}

/** Session id, or the 6-character code from the device that already has Plus. */
export function extractRestoreToken(text: string): RestoreToken | null {
  const sessionId = extractSessionId(text)
  if (sessionId) return { kind: 'session', value: sessionId }
  const code = normalizeRoomCode(text)
  return code ? { kind: 'code', value: code } : null
}
