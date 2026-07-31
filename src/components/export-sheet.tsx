import { useSheetModal } from '../hooks/use-sheet-modal'
import { BrandMark } from './brand-mark'

export type ExportStatus = 'exporting' | 'ready' | 'error'

interface ExportSheetProps {
  /** The exporting state renders as the full-screen ExportOverlay instead. */
  status: 'ready' | 'error'
  error: string | null
  /** Whether the exported file can go through the system share sheet. */
  canShare: boolean
  fileExtension: string | null
  fileSizeBytes: number | null
  /** Feedback after a share/save action ("Saved to downloads", …). */
  notice: string | null
  /** True when THIS export was stamped with the Kody Video mark. */
  watermarked: boolean
  /** True when the removal purchase is unlocked (may change mid-sheet). */
  purchased: boolean
  /** A share/save is in flight — dismissal would drop its result notice. */
  busy: boolean
  onShare: () => void
  onSave: () => void
  onSaveClips: () => void
  onRemoveWatermark: () => void
  onRestorePurchase: () => void
  onRetry: () => void
  /** Fresh render, bypassing the persisted last-export cache. */
  onReExport: () => void
  onClose: () => void
}

/**
 * OK Video-style export flow: tapping OK immediately starts the export
 * ("Exporting your video…"), then offers Share / Save from fresh taps so the
 * system share sheet always has the user activation it requires.
 */
export function ExportSheet({
  status,
  error,
  canShare,
  fileExtension,
  fileSizeBytes,
  notice,
  watermarked,
  purchased,
  busy,
  onShare,
  onSave,
  onSaveClips,
  onRemoveWatermark,
  onRestorePurchase,
  onRetry,
  onReExport,
  onClose,
}: ExportSheetProps) {
  const bindSheet = useSheetModal({ onDismiss: onClose, busy })
  return (
    <>
      <div
        className="sheet-backdrop"
        onClick={() => {
          if (!busy) onClose()
        }}
      />
      <div
        className="sheet export-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Share project"
        ref={bindSheet}
      >
        {status === 'ready' ? (
          <>
            <BrandMark size={84} className="export-celebrate-art" variant="share" />
            <h3>Done! Your video is ready</h3>
            <p className="muted sheet-lede">
              {formatFileInfo(fileExtension, fileSizeBytes)} — it stays on this device until you
              share it.
            </p>
            {notice ? <p className="sheet-message">{notice}</p> : null}
            <div className="sheet-actions">
              {canShare ? (
                <button type="button" className="btn btn-primary" onClick={onShare} disabled={busy}>
                  Share
                </button>
              ) : null}
              <button
                type="button"
                className={`btn ${canShare ? 'btn-secondary' : 'btn-primary'}`}
                onClick={onSave}
                disabled={busy}
              >
                Save
              </button>
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
                Done
              </button>
            </div>
            <p className="sheet-utility-links">
              <button type="button" className="link-button" onClick={onSaveClips} disabled={busy}>
                Save original clips (.zip)
              </button>{' '}
              ·{' '}
              <button type="button" className="link-button" onClick={onReExport} disabled={busy}>
                Re-export from scratch
              </button>
            </p>
            {watermarked && !purchased ? (
              <p className="watermark-note">
                Includes a small Kody mark in the corner.{' '}
                <button type="button" className="link-button" onClick={onRemoveWatermark}>
                  Get Plus — $0.99 removes it & unlocks 6 projects
                </button>{' '}
                ·{' '}
                <button type="button" className="link-button" onClick={onRestorePurchase}>
                  Already paid?
                </button>
              </p>
            ) : null}
            {watermarked && purchased ? (
              <p className="watermark-note">
                This video still includes the Kody mark — tap Go again for a clean export.
              </p>
            ) : null}
          </>
        ) : null}

        {status === 'error' ? (
          <>
            <h3>Export hit a snag</h3>
            <p className="sheet-message is-error">{error ?? 'Something went wrong.'}</p>
            {notice ? <p className="sheet-message">{notice}</p> : null}
            <div className="sheet-actions">
              <button type="button" className="btn btn-primary" onClick={onRetry} disabled={busy}>
                Try again
              </button>
              <button type="button" className="btn btn-secondary" onClick={onSaveClips} disabled={busy}>
                Save clips (.zip) instead
              </button>
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
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
