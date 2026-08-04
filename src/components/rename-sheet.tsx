import type { Handle } from 'remix/ui'
import { on, ref } from 'remix/ui'
import { attachSheetModal } from '../lib/sheet-modal'

interface RenameSheetProps {
  initialName: string
  title?: string
  confirmLabel?: string
  onClose: () => void
  onSave: (name: string) => Promise<void>
}

/** Remount with key={projectId} when renaming a different project. */
export function RenameSheet(handle: Handle<RenameSheetProps>) {
  let name = handle.props.initialName
  let busy = false
  let error: string | null = null

  const save = async () => {
    busy = true
    error = null
    void handle.update()
    try {
      await handle.props.onSave(name.trim())
      handle.props.onClose()
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not save'
    } finally {
      busy = false
      void handle.update()
    }
  }

  return () => {
    const { title = 'Rename project', confirmLabel = 'Save', onClose } = handle.props

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
          aria-label={title}
          mix={ref((node, signal) =>
            attachSheetModal(node as HTMLElement, signal, {
              onDismiss: () => handle.props.onClose(),
              busy: () => busy,
            }),
          )}
        >
          <h3>{title}</h3>
          <div className="field">
            <label htmlFor="project-name">Name</label>
            <input
              id="project-name"
              type="text"
              value={name}
              maxLength={48}
              mix={[
                ref((node) => (node as HTMLInputElement).focus()),
                on('input', (event) => {
                  name = (event.currentTarget as HTMLInputElement).value
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
              disabled={busy || !name.trim()}
              mix={on('click', () => void save())}
            >
              {busy ? 'Saving…' : confirmLabel}
            </button>
          </div>
        </div>
      </>
    )
  }
}
