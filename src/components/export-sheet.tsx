import { BrandMark } from './brand-mark'

export type ExportStatus = 'exporting' | 'ready' | 'error'

interface ExportSheetProps {
  projectName: string
  status: ExportStatus
  progress: number
  error: string | null
  /** Whether the exported file can go through the system share sheet. */
  canShare: boolean
  fileExtension: string | null
  fileSizeBytes: number | null
  /** Feedback after a share/save action ("Saved to downloads", …). */
  notice: string | null
  onShare: () => void
  onSave: () => void
  onSaveClips: () => void
  onRetry: () => void
  onClose: () => void
}

/**
 * OK Video-style export flow: tapping OK immediately starts the export
 * ("Exporting your video…"), then offers Share / Save from fresh taps so the
 * system share sheet always has the user activation it requires.
 */
export function ExportSheet({
  projectName,
  status,
  progress,
  error,
  canShare,
  fileExtension,
  fileSizeBytes,
  notice,
  onShare,
  onSave,
  onSaveClips,
  onRetry,
  onClose,
}: ExportSheetProps) {
  const exporting = status === 'exporting'

  return (
    <>
      <div
        className="sheet-backdrop"
        onClick={() => {
          if (!exporting) onClose()
        }}
      />
      <div className="sheet export-sheet" role="dialog" aria-label="Share project">
        {status === 'exporting' ? (
          <>
            <h3>Exporting your video…</h3>
            <p className="muted sheet-lede">
              Stitching {projectName} into one video, right on this device.
            </p>
            <div className="progress-bar" aria-label="Export progress">
              <span style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <p className="muted export-percent">{Math.round(progress * 100)}%</p>
          </>
        ) : null}

        {status === 'ready' ? (
          <>
            <BrandMark size={84} className="export-celebrate-art" variant="share" />
            <h3>OK! Your video is ready</h3>
            <p className="muted sheet-lede">
              {formatFileInfo(fileExtension, fileSizeBytes)} — it stays on this device until you
              share it.
            </p>
            {notice ? <p className="sheet-message">{notice}</p> : null}
            <div className="sheet-actions">
              {canShare ? (
                <button type="button" className="btn btn-primary" onClick={onShare}>
                  Share
                </button>
              ) : null}
              <button
                type="button"
                className={`btn ${canShare ? 'btn-secondary' : 'btn-primary'}`}
                onClick={onSave}
              >
                Save
              </button>
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : null}

        {status === 'error' ? (
          <>
            <h3>Export hit a snag</h3>
            <p className="sheet-message is-error">{error ?? 'Something went wrong.'}</p>
            {notice ? <p className="sheet-message">{notice}</p> : null}
            <div className="sheet-actions">
              <button type="button" className="btn btn-primary" onClick={onRetry}>
                Try again
              </button>
              <button type="button" className="btn btn-secondary" onClick={onSaveClips}>
                Save clips instead
              </button>
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : null}
      </div>
    </>
  )
}

function formatFileInfo(ext: string | null, bytes: number | null): string {
  const type = ext ? ext.toUpperCase() : 'Video'
  if (bytes === null) return type
  const mb = bytes / (1024 * 1024)
  return `${type} · ${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`
}
