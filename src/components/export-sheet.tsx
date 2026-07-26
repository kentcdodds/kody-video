interface ExportSheetProps {
  projectName: string
  progress: number | null
  busy: boolean
  message: string | null
  onExport: () => void
  onDownloadClips: () => void
  onClose: () => void
}

export function ExportSheet({
  projectName,
  progress,
  busy,
  message,
  onExport,
  onDownloadClips,
  onClose,
}: ExportSheetProps) {
  return (
    <div className="sheet" role="dialog" aria-label="Export project">
      <h3>Share {projectName}</h3>
      <p className="muted" style={{ margin: 0, lineHeight: 1.45 }}>
        Export stays on this device. We stitch clips into one WebM via canvas capture (re-encodes;
        quality varies by browser). If stitching fails, download clips individually.
      </p>
      {progress !== null ? (
        <div className="progress-bar" aria-label="Export progress">
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      ) : null}
      {message ? <p style={{ margin: '12px 0 0' }}>{message}</p> : null}
      <div className="sheet-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
          Close
        </button>
        <button type="button" className="btn btn-secondary" onClick={onDownloadClips} disabled={busy}>
          Files
        </button>
        <button type="button" className="btn btn-primary" onClick={onExport} disabled={busy}>
          {busy ? 'Working…' : 'Export'}
        </button>
      </div>
    </div>
  )
}
