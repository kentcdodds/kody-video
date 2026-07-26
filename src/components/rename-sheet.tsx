import { useState } from 'react'

interface RenameSheetProps {
  initialName: string
  title?: string
  confirmLabel?: string
  onClose: () => void
  onSave: (name: string) => Promise<void>
}

/** Remount with key={projectId} when renaming a different project. */
export function RenameSheet({
  initialName,
  title = 'Rename project',
  confirmLabel = 'Save',
  onClose,
  onSave,
}: RenameSheetProps) {
  const [name, setName] = useState(initialName)
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
      <div className="sheet" role="dialog" aria-label={title}>
        <h3>{title}</h3>
        <div className="field">
          <label htmlFor="project-name">Name</label>
          <input
            id="project-name"
            type="text"
            value={name}
            autoFocus
            maxLength={48}
            onChange={(e) => setName(e.target.value)}
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
            disabled={busy || !name.trim()}
            onClick={() => {
              void (async () => {
                setBusy(true)
                setError(null)
                try {
                  await onSave(name.trim())
                  onClose()
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Could not save')
                } finally {
                  setBusy(false)
                }
              })()
            }}
          >
            {busy ? 'Saving…' : confirmLabel}
          </button>
        </div>
      </div>
    </>
  )
}
