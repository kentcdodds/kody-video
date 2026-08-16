import type { Handle } from 'remix/ui'
import { on, ref } from 'remix/ui'
import { attachSheetModal } from '../lib/sheet-modal'

interface HomeOptionsSheetProps {
  projectName: string
  onOpen: () => void
  onRename: () => void
  onBackup: () => void
  onSend: () => void
  onDelete: () => void
  onClose: () => void
}

/** Bottom sheet with Open / Rename / Backup / Delete for a filled project slot. */
export function HomeOptionsSheet(handle: Handle<HomeOptionsSheetProps>) {
  return () => {
    const { projectName, onOpen, onRename, onBackup, onSend, onDelete, onClose } = handle.props
    return (
      <>
        <div className="sheet-backdrop" mix={on('click', () => onClose())} />
        <div
          className="sheet home-options-sheet"
          role="dialog"
          aria-modal="true"
          aria-label={`Options for ${projectName}`}
          mix={ref((node, signal) =>
            attachSheetModal(node as HTMLElement, signal, {
              onDismiss: () => handle.props.onClose(),
            }),
          )}
        >
          <h3>{projectName}</h3>
          <p className="sheet-lede muted">What do you want to do?</p>
          <div className="home-options-list">
            <button type="button" className="home-option-btn" mix={on('click', () => onOpen())}>
              Open
            </button>
            <button type="button" className="home-option-btn" mix={on('click', () => onRename())}>
              Rename
            </button>
            <button type="button" className="home-option-btn" mix={on('click', () => onSend())}>
              Send to device
            </button>
            <button type="button" className="home-option-btn" mix={on('click', () => onBackup())}>
              Save backup
            </button>
            <button
              type="button"
              className="home-option-btn home-option-danger"
              mix={on('click', () => onDelete())}
            >
              Delete
            </button>
          </div>
          <div className="sheet-actions">
            <button type="button" className="btn btn-ghost" mix={on('click', () => onClose())}>
              Cancel
            </button>
          </div>
        </div>
      </>
    )
  }
}
