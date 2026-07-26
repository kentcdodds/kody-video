interface HomeOptionsSheetProps {
  projectName: string
  onOpen: () => void
  onRename: () => void
  onDelete: () => void
  onClose: () => void
}

/** Bottom sheet with Open / Rename / Delete for a filled project slot. */
export function HomeOptionsSheet({
  projectName,
  onOpen,
  onRename,
  onDelete,
  onClose,
}: HomeOptionsSheetProps) {
  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet home-options-sheet" role="dialog" aria-label={`Options for ${projectName}`}>
        <h3>{projectName}</h3>
        <p className="sheet-lede muted">What do you want to do?</p>
        <div className="home-options-list">
          <button type="button" className="home-option-btn" onClick={onOpen}>
            Open
          </button>
          <button type="button" className="home-option-btn" onClick={onRename}>
            Rename
          </button>
          <button type="button" className="home-option-btn home-option-danger" onClick={onDelete}>
            Delete
          </button>
        </div>
        <div className="sheet-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </>
  )
}
