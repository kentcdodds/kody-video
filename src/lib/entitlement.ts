import { getDb, getSettings } from './storage'
import type { AppMeta } from './types'

/** Stripe Payment Link for the one-time "Remove Watermark" unlock ($0.99). */
export const REMOVE_WATERMARK_LINK = 'https://buy.stripe.com/00wfZi71ibU30rk9hU2Ry07'

const SESSION_ID_PATTERN = /cs_(?:live|test)_[a-zA-Z0-9]+/

export async function isWatermarkRemoved(): Promise<boolean> {
  const settings = await getSettings()
  return settings.watermarkRemoved === true
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
}

/**
 * Ask the Pages Function to confirm a Stripe Checkout session, and persist
 * the entitlement when it checks out.
 */
export async function verifyPurchaseSession(sessionId: string): Promise<VerifyResult> {
  try {
    const response = await fetch(
      `/api/verify-purchase?session_id=${encodeURIComponent(sessionId)}`,
      { headers: { accept: 'application/json' } },
    )
    const body = (await response.json().catch(() => null)) as VerifyResult | null
    if (response.ok && body?.unlocked) {
      await markWatermarkRemoved(sessionId)
      return { unlocked: true }
    }
    return {
      unlocked: false,
      error: body?.error ?? 'Could not verify the purchase. Try again shortly.',
    }
  } catch {
    return { unlocked: false, error: 'Could not verify the purchase — are you offline?' }
  }
}

/** Pull a checkout session id out of pasted text (receipt URL, session id, …). */
export function extractSessionId(text: string): string | null {
  const match = text.match(SESSION_ID_PATTERN)
  return match ? match[0] : null
}
