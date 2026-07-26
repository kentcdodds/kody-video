interface EditorToolsSheetProps {
  canAct: boolean
  canUndo: boolean
  onDuplicate: () => void
  onMoveLeft: () => void
  onMoveRight: () => void
  onUndo: () => void
  onClose: () => void
}

export function EditorToolsSheet({
  canAct,
  canUndo,
  onDuplicate,
  onMoveLeft,
  onMoveRight,
  onUndo,
  onClose,
}: EditorToolsSheetProps) {
  return (
    <div className="sheet tools-sheet" role="dialog" aria-label="Editor tools">
      <h3>Clip tools</h3>
      <p className="muted" style={{ margin: 0, lineHeight: 1.45 }}>
        Reorder, duplicate, or undo without crowding the timeline.
      </p>
      <div className="tools-sheet-list">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!canAct}
          onClick={() => {
            onClose()
            onDuplicate()
          }}
        >
          Duplicate
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!canAct}
          onClick={() => {
            onClose()
            onMoveLeft()
          }}
        >
          Move left
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!canAct}
          onClick={() => {
            onClose()
            onMoveRight()
          }}
        >
          Move right
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!canUndo}
          onClick={() => {
            onClose()
            onUndo()
          }}
        >
          Undo delete
        </button>
      </div>
      <div className="sheet-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}
