import { useState } from 'react'
import { extractSessionId, verifyPurchaseSession } from '../lib/entitlement'

interface RestoreSheetProps {
  onRestored: () => void
  onClose: () => void
}

/**
 * Restore the "Remove Watermark" purchase on a new device: paste the link
 * from the Stripe receipt email (or the checkout session id) and re-verify.
 */
export function RestoreSheet({ onRestored, onClose }: RestoreSheetProps) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <>
      <div
        className="sheet-backdrop"
        onClick={() => {
          if (!busy) onClose()
        }}
      />
      <div className="sheet" role="dialog" aria-label="Restore purchase">
        <h3>Restore purchase</h3>
        <p className="muted sheet-lede">
          Paste the confirmation link from your Stripe receipt email (or the checkout session id
          starting with “cs_”). We’ll verify it and remove the watermark on this device.
        </p>
        <div className="field">
          <label htmlFor="restore-input">Receipt link or session id</label>
          <input
            id="restore-input"
            type="text"
            value={value}
            autoFocus
            placeholder="https://… or cs_live_…"
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        {error ? <div className="error-banner">{error}</div> : null}
        <div className="sheet-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !extractSessionId(value)}
            onClick={() => {
              const sessionId = extractSessionId(value)
              if (!sessionId) return
              setBusy(true)
              setError(null)
              void verifyPurchaseSession(sessionId).then((result) => {
                setBusy(false)
                if (result.unlocked) {
                  onRestored()
                } else {
                  setError(result.error ?? 'Could not verify the purchase.')
                }
              })
            }}
          >
            {busy ? 'Verifying…' : 'Restore'}
          </button>
        </div>
      </div>
    </>
  )
}
