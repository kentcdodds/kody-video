import { useState } from 'react'

interface ConfirmSheetProps {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => Promise<void> | void
  onClose: () => void
}

/** Destructive confirmation bottom sheet (replaces window.confirm). */
export function ConfirmSheet({
  title,
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  onConfirm,
  onClose,
}: ConfirmSheetProps) {
  const [busy, setBusy] = useState(false)

  return (
    <>
      <div
        className="sheet-backdrop"
        onClick={() => {
          if (!busy) onClose()
        }}
      />
      <div className="sheet confirm-sheet" role="dialog" aria-label={title}>
        <h3>{title}</h3>
        <p className="sheet-lede muted">{message}</p>
        <div className="sheet-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className="btn btn-primary confirm-sheet-danger"
            disabled={busy}
            onClick={() => {
              void (async () => {
                setBusy(true)
                try {
                  await onConfirm()
                  onClose()
                } finally {
                  setBusy(false)
                }
              })()
            }}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </>
  )
}
