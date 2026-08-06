import type { Handle } from 'remix/ui'
import { on, ref } from 'remix/ui'
import { attachSheetModal } from '../lib/sheet-modal'
import { extractSessionId, verifyPurchaseSession } from '../lib/entitlement'

interface RestoreSheetProps {
  onRestored: () => void
  onClose: () => void
}

/**
 * Restore the Kody Video Plus purchase on a new device: paste the link
 * from the Stripe receipt email (or the checkout session id) and re-verify.
 */
export function RestoreSheet(handle: Handle<RestoreSheetProps>) {
  let value = ''
  let busy = false
  let error: string | null = null

  const restore = async () => {
    const sessionId = extractSessionId(value)
    if (!sessionId) return
    busy = true
    error = null
    void handle.update()
    const result = await verifyPurchaseSession(sessionId)
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
            Paste the confirmation link from your Stripe receipt email (or the checkout session id
            starting with “cs_”). We’ll verify it and remove the watermark on this device.
          </p>
          <div className="field">
            <label htmlFor="restore-input">Receipt link or session id</label>
            <input
              id="restore-input"
              type="text"
              value={value}
              placeholder="https://… or cs_live_…"
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
              disabled={busy || !extractSessionId(value)}
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
