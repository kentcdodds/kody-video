import type { Handle } from 'remix/ui'
import { on, ref } from 'remix/ui'
import { attachSheetModal } from '../lib/sheet-modal'
import { REMOVE_WATERMARK_LINK } from '../lib/entitlement'
import { MAX_PROJECTS } from '../lib/types'

interface UpsellSheetProps {
  onClose: () => void
  /** Switch to the restore-purchase flow (owner keeps both sheets exclusive). */
  onRestore: () => void
}

/** The one-time Kody Video Plus purchase: watermark removal + more projects. */
export function UpsellSheet(handle: Handle<UpsellSheetProps>) {
  return () => {
    const { onClose, onRestore } = handle.props
    return (
      <>
        <div className="sheet-backdrop" mix={on('click', () => onClose())} />
        <div
          className="sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Kody Video Plus"
          mix={ref((node, signal) =>
            attachSheetModal(node as HTMLElement, signal, {
              onDismiss: () => handle.props.onClose(),
            }),
          )}
        >
          <h3>Kody Video Plus</h3>
          <p className="sheet-copy">
            The free plan includes 1 project. Plus is a one-time $0.99 purchase that unlocks{' '}
            {MAX_PROJECTS} project slots, background music for your films, and removes the
            watermark from exports — forever, on this device and any device you restore it on.
          </p>
          <div className="sheet-actions">
            <button type="button" className="btn btn-ghost" mix={on('click', () => onClose())}>
              Not now
            </button>
            <button
              type="button"
              className="btn btn-primary"
              mix={on('click', () => {
                window.open(REMOVE_WATERMARK_LINK, '_blank', 'noopener')
                handle.props.onClose()
              })}
            >
              Get Plus — $0.99
            </button>
          </div>
          <button
            type="button"
            className="link-button sheet-footnote"
            mix={on('click', () => onRestore())}
          >
            Already paid? Restore your purchase
          </button>
        </div>
      </>
    )
  }
}
