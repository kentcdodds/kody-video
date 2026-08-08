import type { Handle } from 'remix/ui'
import { BrandMark } from '../components/brand-mark'
import { verifyPurchaseSession, type VerifyResult } from '../lib/entitlement'

/**
 * Stripe's Payment Link redirects here after checkout with
 * ?session_id={CHECKOUT_SESSION_ID}; setup verifies it server-side and
 * persists the entitlement before rendering the result.
 */
async function verifyFromLocation(): Promise<VerifyResult> {
  const sessionId = new URL(window.location.href).searchParams.get('session_id')
  if (!sessionId) {
    return { unlocked: false, error: 'Missing checkout session. Use the link from your receipt.' }
  }
  return verifyPurchaseSession(sessionId)
}

export function UnlockedPage(handle: Handle) {
  let result: VerifyResult | null = null

  void verifyFromLocation().then((verified) => {
    if (handle.signal.aborted) return
    result = verified
    void handle.update()
  })

  return () => (
    <div className="screen unlocked-screen">
      <div className="unlocked-card">
        <BrandMark size={110} className="export-celebrate-art" variant="share" />
        {result === null ? (
          <>
            <p className="eyebrow">Checking your purchase…</p>
            <h1>One moment</h1>
          </>
        ) : result.unlocked ? (
          <>
            <p className="eyebrow">Purchase verified</p>
            <h1>Kody Video Plus unlocked! 🎉</h1>
            <p className="muted">
              Thank you for supporting Kody Video. Every export from this device is now
              watermark-free, all six project slots are open, and optional location tagging is
              available. Keep your Stripe receipt email — its link restores the purchase on another
              device.
            </p>
          </>
        ) : (
          <>
            <p className="eyebrow">Verification failed</p>
            <h1>Hmm, that didn’t check out</h1>
            <p className="muted">
              {result.error ?? 'Could not verify this purchase.'} If you paid and keep seeing
              this, retry from the link in your Stripe receipt email.
            </p>
          </>
        )}
        {result === null ? null : (
          <a className="btn btn-primary" href="/">
            {result.unlocked ? 'Start creating' : 'Back to Kody Video'}
          </a>
        )}
      </div>
    </div>
  )
}
