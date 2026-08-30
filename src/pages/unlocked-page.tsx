import type { Handle } from 'remix/ui'
import { on, ref } from 'remix/ui'
import { IconBack } from '../components/icons'
import { BrandMark } from '../components/brand-mark'
import { SharePlusSheet } from '../components/share-plus-sheet'
import {
  extractRestoreToken,
  looksLikeStripeReceipt,
  verifyPurchase,
  type VerifyResult,
} from '../lib/entitlement'
import { formatRoomCode } from '../lib/sync-protocol'

interface UnlockedPageProps {
  /** Path segment from /unlocked/:code — same shape as /receive/:code. */
  code?: string
}

type UnlockPhase = 'enter' | 'checking' | 'unlocked' | 'failed'

function rawTokenFromLocation(pathCode?: string): string {
  const params = new URL(window.location.href).searchParams
  return params.get('session_id') ?? params.get('code') ?? pathCode ?? ''
}

function missingTokenMessage(raw: string): string {
  if (looksLikeStripeReceipt(raw)) {
    return 'Stripe receipt links do not include a restore handle. On the device that already has Plus, open About and tap Use Plus on another device.'
  }
  return 'Enter the short code from the other device, or a checkout session id starting with “cs_”.'
}

function phaseCopy(phase: UnlockPhase, error: string | null): string {
  switch (phase) {
    case 'enter':
      return 'Type the code from the other device, or open the link / QR it showed.'
    case 'checking':
      return 'Checking your purchase…'
    case 'unlocked':
      return 'Purchase verified'
    case 'failed':
      return error ?? 'Could not verify this purchase.'
    default: {
      const exhaustive: never = phase
      return exhaustive
    }
  }
}

/**
 * Stripe's Payment Link redirects here after checkout with
 * ?session_id={CHECKOUT_SESSION_ID}. A Plus device can also mint a short
 * code whose QR opens /unlocked/ABC123 (legacy ?code= still works). Bare
 * /unlocked shows a form so people can type the code — same idea as
 * /receive. Setup verifies server-side and persists the entitlement.
 */
export function UnlockedPage(handle: Handle<UnlockedPageProps>) {
  const initialRaw = rawTokenFromLocation(handle.props.code)
  const initialToken = extractRestoreToken(initialRaw)
  let typed = handle.props.code ?? ''
  let phase: UnlockPhase = initialToken ? 'checking' : initialRaw ? 'failed' : 'enter'
  let result: VerifyResult | null = initialToken
    ? null
    : initialRaw
      ? { unlocked: false, error: missingTokenMessage(initialRaw) }
      : null
  let sharing = false

  const verify = (raw: string) => {
    const token = extractRestoreToken(raw)
    if (!token) {
      result = { unlocked: false, error: missingTokenMessage(raw) }
      phase = 'failed'
      void handle.update()
      return
    }
    // Remix wires scheduleUpdate only after the first render commits. Calling
    // handle.update() synchronously from setup (before any await) rejects with
    // "scheduleUpdate not implemented". Mount with a token already starts in
    // checking, so skip that paint; form submit still needs it.
    const needsCheckingPaint = phase !== 'checking' || result !== null
    phase = 'checking'
    result = null
    if (needsCheckingPaint) void handle.update()
    void verifyPurchase(token).then((verified) => {
      if (handle.signal.aborted) return
      result = verified
      phase = verified.unlocked ? 'unlocked' : 'failed'
      void handle.update()
    })
  }

  if (initialToken) verify(initialRaw)

  return () => (
    <div className="screen about-screen receive-screen">
      <div className="about-top">
        <a href="/" className="btn-icon" aria-label="Back to projects">
          <IconBack />
        </a>
        <strong>Unlock Plus</strong>
        <span className="about-top-spacer" aria-hidden="true" />
      </div>
      <div className="about-body">
        <div className="about-hero" aria-hidden="true">
          <BrandMark
            size={96}
            className={phase === 'unlocked' ? 'export-celebrate-art' : 'brand-hero-art'}
            variant={phase === 'unlocked' ? 'share' : 'icon'}
          />
        </div>
        {phase === 'unlocked' ? (
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
            <h1>{phase === 'checking' ? 'One moment' : 'Unlock Plus'}</h1>
            <p className="muted">
              {phaseCopy(phase, result?.error ?? null)}
            </p>
          </>
        )}
        {handle.props.code && phase === 'checking' ? (
          <p className="sync-code receive-code">{formatRoomCode(handle.props.code)}</p>
        ) : null}
        {phase === 'enter' || phase === 'failed' ? (
          <form
            className="receive-form"
            mix={on('submit', (event) => {
              event.preventDefault()
              verify(typed)
            })}
          >
            <div className="field">
              <label htmlFor="unlock-code">Plus code</label>
              <input
                id="unlock-code"
                type="text"
                inputMode="text"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="off"
                placeholder="ABC-234"
                value={typed}
                mix={[
                  ref((node) => {
                    if (phase === 'enter') (node as HTMLInputElement).focus()
                  }),
                  on('input', (event) => {
                    typed = (event.currentTarget as HTMLInputElement).value
                    void handle.update()
                  }),
                ]}
              />
            </div>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!extractRestoreToken(typed)}
            >
              Unlock
            </button>
          </form>
        ) : null}
        {phase === 'unlocked' ? (
          <div className="sheet-actions receive-actions">
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
        ) : null}
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
