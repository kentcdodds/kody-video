import type { Handle } from 'remix/ui'
import { on, ref } from 'remix/ui'
import { attachSheetModal } from '../lib/sheet-modal'

interface ConfirmSheetProps {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => Promise<void> | void
  onClose: () => void
}

/** Destructive confirmation bottom sheet (replaces window.confirm). */
export function ConfirmSheet(handle: Handle<ConfirmSheetProps>) {
  let busy = false

  return () => {
    const { title, message, confirmLabel = 'Delete', cancelLabel = 'Cancel', onConfirm, onClose } =
      handle.props

    return (
      <>
        <div
          className="sheet-backdrop"
          mix={on('click', () => {
            if (!busy) onClose()
          })}
        />
        <div
          className="sheet confirm-sheet"
          role="dialog"
          aria-modal="true"
          aria-label={title}
          mix={ref((node, signal) =>
            attachSheetModal(node as HTMLElement, signal, {
              onDismiss: () => handle.props.onClose(),
              busy: () => busy,
            }),
          )}
        >
          <h3>{title}</h3>
          <p className="sheet-lede muted">{message}</p>
          <div className="sheet-actions">
            {/* Destructive dialog: initial focus lands on the safe action. */}
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              data-sheet-focus
              mix={on('click', () => onClose())}
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              className="btn btn-primary confirm-sheet-danger"
              disabled={busy}
              mix={on('click', async () => {
                busy = true
                void handle.update()
                try {
                  await onConfirm()
                  handle.props.onClose()
                } finally {
                  busy = false
                  void handle.update()
                }
              })}
            >
              {busy ? 'Working…' : confirmLabel}
            </button>
          </div>
        </div>
      </>
    )
  }
}
