import type { Handle } from 'remix/ui'
import { on } from 'remix/ui'
import { BrandMark } from '../components/brand-mark'
import { SharePlusSheet } from '../components/share-plus-sheet'
import {
  extractRestoreToken,
  verifyPurchase,
  type VerifyResult,
} from '../lib/entitlement'

/**
 * Stripe's Payment Link redirects here after checkout with
 * ?session_id={CHECKOUT_SESSION_ID}. A Plus device can also mint a short
 * code whose QR opens ?code=ABC123. Setup verifies server-side and
 * persists the entitlement before rendering the result.
 */
async function verifyFromLocation(): Promise<VerifyResult> {
  const params = new URL(window.location.href).searchParams
  const raw = params.get('session_id') ?? params.get('code') ?? ''
  const token = extractRestoreToken(raw)
  if (!token) {
    return {
      unlocked: false,
      error: 'Missing checkout session or restore code. Use the code from the other device.',
    }
  }
  return verifyPurchase(token)
}

export function UnlockedPage(handle: Handle) {
  let result: VerifyResult | null = null
  let sharing = false

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
              watermark-free, all six project slots are open, 1080p High quality is available,
              optional location tagging is available, and you can send a project to another device.
              To unlock a second phone or computer, tap Add another device and scan or type the
              short code.
            </p>
          </>
        ) : (
          <>
            <p className="eyebrow">Verification failed</p>
            <h1>Hmm, that didn’t check out</h1>
            <p className="muted">
              {result.error ?? 'Could not verify this purchase.'} If you paid and keep seeing
              this, restore from the device that already has Plus (About → Use Plus on another
              device).
            </p>
          </>
        )}
        {result === null ? null : result.unlocked ? (
          <div className="sheet-actions">
            <button
              type="button"
              className="btn btn-ghost"
              mix={on('click', () => {
                sharing = true
                void handle.update()
              })}
            >
              Add another device
            </button>
            <a className="btn btn-primary" href="/">
              Start creating
            </a>
          </div>
        ) : (
          <a className="btn btn-primary" href="/">
            Back to Kody Video
          </a>
        )}
      </div>
      {sharing ? (
        <SharePlusSheet
          onClose={() => {
            sharing = false
            void handle.update()
          }}
        />
      ) : null}
    </div>
  )
}
