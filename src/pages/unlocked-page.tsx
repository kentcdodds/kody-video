import { Link, useLoaderData, type LoaderFunctionArgs } from 'react-router-dom'
import { BrandMark } from '../components/brand-mark'
import { verifyPurchaseSession, type VerifyResult } from '../lib/entitlement'

/**
 * Stripe's Payment Link redirects here after checkout with
 * ?session_id={CHECKOUT_SESSION_ID}; the loader verifies it server-side and
 * persists the entitlement before the page renders.
 */
export async function unlockedLoader({ request }: LoaderFunctionArgs): Promise<VerifyResult> {
  const sessionId = new URL(request.url).searchParams.get('session_id')
  if (!sessionId) {
    return { unlocked: false, error: 'Missing checkout session. Use the link from your receipt.' }
  }
  return verifyPurchaseSession(sessionId)
}

export function UnlockedPage() {
  const result = useLoaderData() as VerifyResult

  return (
    <div className="screen unlocked-screen">
      <div className="unlocked-card">
        <BrandMark size={110} className="export-celebrate-art" variant="share" />
        {result.unlocked ? (
          <>
            <p className="eyebrow">Purchase verified</p>
            <h1>Kody Video Plus unlocked! 🎉</h1>
            <p className="muted">
              Thank you for supporting Kody Video. Every export from this device is now
              watermark-free and all six project slots are open. Keep your Stripe receipt email —
              its link restores the purchase on another device.
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
        <Link className="btn btn-primary" to="/">
          {result.unlocked ? 'Start creating' : 'Back to Kody Video'}
        </Link>
      </div>
    </div>
  )
}
