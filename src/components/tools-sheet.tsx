interface ToolsSheetProps {
  canDeleteLast: boolean
  canFlip: boolean
  recording: boolean
  countdownActive: boolean
  onEditor: () => void
  onTimer: () => void
  onDeleteLast: () => void
  onFlip: () => void
  onClose: () => void
}

export function ToolsSheet({
  canDeleteLast,
  canFlip,
  recording,
  countdownActive,
  onEditor,
  onTimer,
  onDeleteLast,
  onFlip,
  onClose,
}: ToolsSheetProps) {
  return (
    <div className="sheet tools-sheet" role="dialog" aria-label="Recording tools">
      <h3>Tools</h3>
      <p className="muted" style={{ margin: 0, lineHeight: 1.45 }}>
        Keep the camera clear — open editor, flip, timer, or delete from here.
      </p>
      <div className="tools-sheet-list">
        <button
          type="button"
          className="btn btn-primary"
          disabled={recording}
          onClick={() => {
            onClose()
            onEditor()
          }}
        >
          Editor
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={recording || countdownActive}
          onClick={() => {
            onClose()
            onTimer()
          }}
        >
          Timer
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!canFlip || recording}
          onClick={() => {
            onClose()
            onFlip()
          }}
        >
          Flip camera
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!canDeleteLast || recording}
          onClick={() => {
            onClose()
            onDeleteLast()
          }}
        >
          Delete last
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
