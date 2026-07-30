import { useSheetModal } from '../hooks/use-sheet-modal'
import { REMOVE_WATERMARK_LINK } from '../lib/entitlement'
import { MAX_PROJECTS } from '../lib/types'

interface UpsellSheetProps {
  onClose: () => void
  /** Switch to the restore-purchase flow (owner keeps both sheets exclusive). */
  onRestore: () => void
}

/** The one-time Kody Video Plus purchase: watermark removal + more projects. */
export function UpsellSheet({ onClose, onRestore }: UpsellSheetProps) {
  const bindSheet = useSheetModal({ onDismiss: onClose })

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Kody Video Plus"
        ref={bindSheet}
      >
        <h3>Kody Video Plus</h3>
        <p className="sheet-copy">
          The free plan includes 1 project. Plus is a one-time $0.99 purchase that unlocks{' '}
          {MAX_PROJECTS} project slots and removes the watermark from exports — forever, on this
          device and any device you restore it on.
        </p>
        <div className="sheet-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Not now
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              window.open(REMOVE_WATERMARK_LINK, '_blank', 'noopener')
              onClose()
            }}
          >
            Get Plus — $0.99
          </button>
        </div>
        <button type="button" className="link-button sheet-footnote" onClick={onRestore}>
          Already paid? Restore your purchase
        </button>
      </div>
    </>
  )
}
