import type { Handle } from 'remix/ui'
import { on, ref } from 'remix/ui'
import { attachSheetModal } from '../lib/sheet-modal'
import { BrandMark } from './brand-mark'

export type ExportStatus = 'exporting' | 'ready' | 'error'

/** Same destination the About page credits — native hold-to-record on iPhone. */
export const OK_VIDEO_URL = 'https://okvideo.app'

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
  /** Plus opt-in: keep stamping the mark on future exports. */
  keepWatermark: boolean
  /** Plus opt-in: include captured coordinates in future MP4 exports. */
  includeLocation: boolean
  /** Whether THIS exported file contains captured coordinates. */
  locationIncluded: boolean
  /** Whether any clip in the current project carries captured coordinates. */
  hasTaggedClips: boolean
  /**
   * True when this run used the realtime canvas fallback. Shows a dismissible
   * backup / try-elsewhere hint (session-only; resets on the next export).
   */
  usedFallback: boolean
  /** A share/save is in flight — dismissal would drop its result notice. */
  busy: boolean
  onKeepWatermarkChange: (keep: boolean) => void
  onIncludeLocationChange: (include: boolean) => void
  onShare: () => void
  onSave: () => void
  onSaveClips: () => void
  onSaveBackup: () => void
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
export function ExportSheet(handle: Handle<ExportSheetProps>) {
  const { props } = handle
  let fallbackHintDismissed = false

  return () => {
    const {
      status,
      error,
      canShare,
      fileExtension,
      fileSizeBytes,
      notice,
      watermarked,
      purchased,
      keepWatermark,
      includeLocation,
      locationIncluded,
      hasTaggedClips,
      usedFallback,
      busy,
      onKeepWatermarkChange,
      onIncludeLocationChange,
      onShare,
      onSave,
      onSaveClips,
      onSaveBackup,
      onRemoveWatermark,
      onRestorePurchase,
      onRetry,
      onReExport,
      onClose,
    } = props
    const showFallbackHint = usedFallback && !fallbackHintDismissed
    return (
      <>
        <div
          className="sheet-backdrop"
          mix={on('click', () => {
            if (!props.busy) props.onClose()
          })}
        />
        <div
          className="sheet export-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Share project"
          mix={ref((node, signal) =>
            attachSheetModal(node as HTMLElement, signal, {
              onDismiss: () => props.onClose(),
              busy: () => props.busy,
            }),
          )}
        >
          {status === 'ready' ? (
            <>
              <BrandMark size={84} className="export-celebrate-art" variant="share" />
              <h3>Done! Your video is ready</h3>
              <p className="muted sheet-lede">
                {formatFileInfo(fileExtension, fileSizeBytes)} — it stays on this device until you
                share it.
              </p>
              {showFallbackHint
                ? fallbackHint({
                    busy,
                    onSaveBackup,
                    onDismiss: () => {
                      fallbackHintDismissed = true
                      void handle.update()
                    },
                  })
                : null}
              {notice ? <p className="sheet-message">{notice}</p> : null}
              <div className="sheet-actions">
                {canShare ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    mix={on('click', () => onShare())}
                  >
                    Share
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`btn ${canShare ? 'btn-secondary' : 'btn-primary'}`}
                  disabled={busy}
                  mix={on('click', () => onSave())}
                >
                  Save
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  mix={on('click', () => onClose())}
                >
                  Done
                </button>
              </div>
              <p className="sheet-utility-links">
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  mix={on('click', () => onSaveClips())}
                >
                  Save original clips (.zip)
                </button>{' '}
                ·{' '}
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  mix={on('click', () => onReExport())}
                >
                  Re-export from scratch
                </button>
              </p>
              {watermarked && !purchased ? (
                <p className="watermark-note">
                  Includes a small Kody mark in the corner.{' '}
                  <button
                    type="button"
                    className="link-button"
                    mix={on('click', () => onRemoveWatermark())}
                  >
                    Get Plus — $0.99 removes it & unlocks 6 projects
                  </button>{' '}
                  ·{' '}
                  <button
                    type="button"
                    className="link-button"
                    mix={on('click', () => onRestorePurchase())}
                  >
                    Already paid?
                  </button>
                </p>
              ) : null}
              {purchased ? (
                <div className="export-prefs">
                  <label className="export-pref-toggle">
                    <input
                      type="checkbox"
                      checked={keepWatermark}
                      disabled={busy}
                      mix={on('change', (event) => {
                        onKeepWatermarkChange((event.currentTarget as HTMLInputElement).checked)
                      })}
                    />
                    Keep the Kody mark on exports
                  </label>
                  <label className="export-pref-toggle">
                    <input
                      type="checkbox"
                      checked={includeLocation}
                      disabled={busy}
                      mix={on('change', (event) => {
                        onIncludeLocationChange(
                          (event.currentTarget as HTMLInputElement).checked,
                        )
                      })}
                    />
                    Include clip locations in MP4 exports
                  </label>
                  {watermarked && !keepWatermark ? (
                    <p className="export-pref-note">
                      This video still includes the Kody mark — tap Re-export from scratch for a
                      clean export.
                    </p>
                  ) : null}
                  {!watermarked && keepWatermark ? (
                    <p className="export-pref-note">
                      Tap Re-export from scratch to stamp the Kody mark on this video.
                    </p>
                  ) : null}
                  {locationIncluded && !includeLocation ? (
                    <p className="export-pref-note">
                      This video still includes clip locations — tap Re-export from scratch to
                      remove them.
                    </p>
                  ) : null}
                  {!locationIncluded &&
                  includeLocation &&
                  hasTaggedClips &&
                  fileExtension === 'mp4' ? (
                    <p className="export-pref-note">
                      Tap Re-export from scratch to include clip locations in this video.
                    </p>
                  ) : null}
                  <p className="export-location-note">
                    Location is off by default. Chapter markers stay in the video either way.
                  </p>
                </div>
              ) : null}
            </>
          ) : null}

          {status === 'error' ? (
            <>
              <h3>Export hit a snag</h3>
              <p className="sheet-message is-error">{error ?? 'Something went wrong.'}</p>
              {showFallbackHint
                ? fallbackHint({
                    busy,
                    onSaveBackup,
                    onDismiss: () => {
                      fallbackHintDismissed = true
                      void handle.update()
                    },
                  })
                : null}
              {notice ? <p className="sheet-message">{notice}</p> : null}
              <div className="sheet-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  mix={on('click', () => onRetry())}
                >
                  Try again
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  mix={on('click', () => onSaveClips())}
                >
                  Save clips (.zip) instead
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  mix={on('click', () => onClose())}
                >
                  Close
                </button>
              </div>
            </>
          ) : null}
        </div>
      </>
    )
  }
}

function fallbackHint(props: {
  busy: boolean
  onSaveBackup: () => void
  onDismiss: () => void
}) {
  const { busy, onSaveBackup, onDismiss } = props
  return (
    <div className="export-fallback-hint" role="status">
      <p>
        This device used a compatibility export. For higher quality, save a project backup and
        import it on a computer (Chrome works best) via About → Import a backup.
      </p>
      <div className="export-fallback-hint-actions">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          mix={on('click', () => onSaveBackup())}
        >
          Save project backup
        </button>
        <button type="button" className="link-button" disabled={busy} mix={on('click', onDismiss)}>
          Dismiss
        </button>
      </div>
      <p className="export-fallback-okvideo muted">
        On iPhone,{' '}
        <a href={OK_VIDEO_URL} target="_blank" rel="noreferrer noopener">
          OK Video
        </a>{' '}
        is a native alternative.
      </p>
    </div>
  )
}

function formatFileInfo(ext: string | null, bytes: number | null): string {
  const type = ext ? ext.toUpperCase() : 'Video'
  if (bytes === null) return type
  const mb = bytes / (1024 * 1024)
  return `${type} · ${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`
}
