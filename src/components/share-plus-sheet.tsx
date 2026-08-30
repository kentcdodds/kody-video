import type { Handle } from 'remix/ui'
import { on, ref } from 'remix/ui'
import { attachSheetModal } from '../lib/sheet-modal'
import { pairingHint, pairingHref } from '../lib/pairing-href'
import { formatRoomCode } from '../lib/sync-protocol'
import { getPurchaseSessionId, mintRestoreCode } from '../lib/entitlement'
import { SyncQr } from './sync-qr'

interface SharePlusSheetProps {
  onClose: () => void
}

/**
 * Plus device: show a short-lived code + QR so another device can unlock.
 */
export function SharePlusSheet(handle: Handle<SharePlusSheetProps>) {
  let code: string | null = null
  let error: string | null = null
  let busy = true
  let copied = false

  const load = async () => {
    // Remix wires scheduleUpdate only after the first render commits. Calling
    // handle.update() synchronously from setup (before any await) rejects with
    // "scheduleUpdate not implemented" — an unhandledrejection on every open.
    // Initial state is already busy=true / empty, so skip that paint; on retry
    // (mounted) we do need a busy paint when leaving an error/code state.
    const needsBusyPaint = !busy || error !== null || code !== null
    busy = true
    error = null
    code = null
    if (needsBusyPaint) void handle.update()
    const sessionId = await getPurchaseSessionId()
    if (!sessionId) {
      busy = false
      error =
        'This device has Plus, but no restore handle is saved. Open the checkout confirmation link, or write team@kody.video.'
      void handle.update()
      return
    }
    const minted = await mintRestoreCode(sessionId)
    busy = false
    if ('error' in minted) {
      error = minted.error
    } else {
      code = minted.code
    }
    if (!handle.signal.aborted) void handle.update()
  }

  void load()

  const unlockHref = () => pairingHref('unlocked', code)

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
          className="sheet send-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Use Plus on another device"
          mix={ref((node, signal) =>
            attachSheetModal(node as HTMLElement, signal, {
              onDismiss: () => handle.props.onClose(),
              busy: () => busy,
            }),
          )}
        >
          <h3>Use Plus on another device</h3>
          <p className={error ? 'sheet-lede is-error' : 'sheet-lede muted'}>
            {error ??
              (busy
                ? 'Making a short code…'
                : `Open ${pairingHint('unlocked')} on the other device and scan or type this code. It expires in 30 minutes.`)}
          </p>
          {code ? (
            <div className="sync-code-block">
              <p className="sync-code" aria-label={`Restore code ${formatRoomCode(code)}`}>
                {formatRoomCode(code)}
              </p>
              <SyncQr href={unlockHref()} label="QR code to unlock Plus on another device" />
              <button
                type="button"
                className="link-button"
                mix={on('click', () => {
                  void navigator.clipboard?.writeText(unlockHref()).then(
                    () => {
                      copied = true
                      void handle.update()
                    },
                    () => undefined,
                  )
                })}
              >
                {copied ? 'Link copied' : 'Copy unlock link'}
              </button>
            </div>
          ) : null}
          <div className="sheet-actions">
            {error ? (
              <button type="button" className="btn btn-primary" mix={on('click', () => void load())}>
                Try again
              </button>
            ) : null}
            <button type="button" className="btn btn-ghost" mix={on('click', () => onClose())}>
              Done
            </button>
          </div>
        </div>
      </>
    )
  }
}
