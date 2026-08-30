import type { Handle } from 'remix/ui'
import { on, ref } from 'remix/ui'
import { attachSheetModal } from '../lib/sheet-modal'
import {
  extractRestoreToken,
  looksLikeStripeReceipt,
  verifyPurchase,
} from '../lib/entitlement'

interface RestoreSheetProps {
  onRestored: () => void
  onClose: () => void
}

/**
 * Restore Kody Video Plus on a new device: paste a short code from the
 * device that already has Plus, scan its QR (opens /unlocked/:code), or
 * paste a checkout session id.
 */
export function RestoreSheet(handle: Handle<RestoreSheetProps>) {
  let value = ''
  let busy = false
  let error: string | null = null

  const restore = async () => {
    const token = extractRestoreToken(value)
    if (!token) {
      error = looksLikeStripeReceipt(value)
        ? 'Stripe receipt links do not include a restore handle. On the device that already has Plus, open About and tap Use Plus on another device.'
        : 'Enter the short code from the other device, or a checkout session id starting with “cs_”.'
      void handle.update()
      return
    }
    busy = true
    error = null
    void handle.update()
    const result = await verifyPurchase(token)
    busy = false
    if (result.unlocked) {
      handle.props.onRestored()
    } else {
      error = result.error ?? 'Could not verify the purchase.'
    }
    // onRestored may have unmounted the sheet — nothing left to update.
    if (!handle.signal.aborted) void handle.update()
  }

  return () => {
    const { onClose } = handle.props
    return (
      <>
        <div
          className="sheet-backdrop"
          mix={on('click', () => {
            if (!busy) onClose()
          })}
        />
        <div
          className="sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Restore purchase"
          mix={ref((node, signal) =>
            attachSheetModal(node as HTMLElement, signal, {
              onDismiss: () => handle.props.onClose(),
              busy: () => busy,
            }),
          )}
        >
          <h3>Restore purchase</h3>
          <p className="muted sheet-lede">
            On the device that already has Plus, open About and tap{' '}
            <strong>Use Plus on another device</strong>. Type that short code here, paste its unlock
            link, or scan the QR. A checkout session id starting with “cs_” still works too.
          </p>
          <div className="field">
            <label htmlFor="restore-input">Restore code or session id</label>
            <input
              id="restore-input"
              type="text"
              inputMode="text"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={value}
              placeholder="ABC-234 or cs_live_…"
              mix={[
                ref((node) => (node as HTMLInputElement).focus()),
                on('input', (event) => {
                  value = (event.currentTarget as HTMLInputElement).value
                  void handle.update()
                }),
              ]}
            />
          </div>
          {error ? <div className="error-banner">{error}</div> : null}
          <div className="sheet-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              mix={on('click', () => onClose())}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !extractRestoreToken(value)}
              mix={on('click', () => void restore())}
            >
              {busy ? 'Verifying…' : 'Restore'}
            </button>
          </div>
        </div>
      </>
    )
  }
}
