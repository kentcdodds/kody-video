import type { Handle } from 'remix/component'
import { on, ref } from 'remix/component'
import { deleteUnexportableClipsLabel } from '../lib/export/clip-check'
import type { ExportFormatSupport } from '../lib/export/export-format'
import type { ExportSizeOption } from '../lib/export/export-size'
import { projectFilename } from '../lib/media'
import type { ClipId, ExportFormat, ExportSize } from '../lib/types'
import { attachSheetModal } from '../lib/sheet-modal'
import { BrandMark } from './brand-mark'
import { ExportFormatPicker } from './export-format-picker'
import { ExportSizePicker } from './export-size-picker'
import { TimelineThumbImage } from './timeline-thumb-image'

export type ExportStatus = 'exporting' | 'ready' | 'error'

/** A clip the export preflight rejected (no video), as the sheet lists it. */
export interface ExportSheetBrokenClip {
  clipId: ClipId
  position: number
  thumb: Blob | null
}

/** Same destination the About page credits — native hold-to-record on iPhone. */
export const OK_VIDEO_URL = 'https://okvideo.app'

interface ExportSheetProps {
  /** The exporting state renders as the full-screen ExportOverlay instead. */
  status: 'ready' | 'error'
  error: string | null
  /** Clips that block the export; the error view offers to delete them. */
  brokenClips: readonly ExportSheetBrokenClip[]
  /** Delete `brokenClips` (normal delete, undoable) and export again. */
  onDeleteBrokenClips: () => void
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
  /** Live project name — used for the Share/Save filename. */
  projectName: string
  /** True when the name is still the generated "Project N". */
  nameIsDefault: boolean
  onRename: (name: string) => void
  /** Size presets this film can use (picker hidden when only Full fits). */
  sizeOptions: readonly ExportSizeOption[]
  exportSize: ExportSize
  /** Pick a different size: re-exports at it right away. */
  onExportSizeChange: (size: ExportSize) => void
  exportFormat: ExportFormat
  formatSupport: ExportFormatSupport | null
  /** Pick a different container: re-exports in it right away. */
  onExportFormatChange: (format: ExportFormat) => void
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
  let name = handle.props.projectName

  const flushName = () => {
    const trimmed = name.trim()
    if (trimmed) handle.props.onRename(trimmed)
  }

  return () => {
    const {
      status,
      error,
      brokenClips,
      onDeleteBrokenClips,
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
      nameIsDefault,
      sizeOptions,
      exportSize,
      onExportSizeChange,
      exportFormat,
      formatSupport,
      onExportFormatChange,
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
              <div className="field export-name-field">
                <label htmlFor="export-project-name">
                  {nameIsDefault ? 'Name this video' : 'Name'}
                </label>
                <input
                  id="export-project-name"
                  type="text"
                  value={name}
                  maxLength={48}
                  disabled={busy}
                  mix={[
                    on('input', (event) => {
                      name = (event.currentTarget as HTMLInputElement).value
                      void handle.update()
                    }),
                    on('change', () => flushName()),
                  ]}
                />
                {fileExtension ? (
                  <p className="muted export-filename-hint">
                    Saves as {projectFilename(name.trim() || handle.props.projectName, fileExtension)}
                  </p>
                ) : null}
              </div>
              <div className="export-size-field">
                <p className="export-size-field-label">Format</p>
                <ExportFormatPicker
                  value={exportFormat}
                  support={formatSupport}
                  actual={fileExtension}
                  disabled={busy}
                  onChange={(format) => {
                    flushName()
                    onExportFormatChange(format)
                  }}
                />
              </div>
              {sizeOptions.length > 1 ? (
                <div className="export-size-field">
                  <p className="export-size-field-label">Size</p>
                  <ExportSizePicker
                    options={sizeOptions}
                    value={exportSize}
                    actualBytes={fileSizeBytes}
                    disabled={busy}
                    onChange={(size) => {
                      flushName()
                      onExportSizeChange(size)
                    }}
                  />
                </div>
              ) : null}
              {showFallbackHint
                ? fallbackHint({
                    busy,
                    onSaveBackup: () => {
                      flushName()
                      onSaveBackup()
                    },
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
                    mix={on('click', () => {
                      flushName()
                      onShare()
                    })}
                  >
                    Share
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`btn ${canShare ? 'btn-secondary' : 'btn-primary'}`}
                  disabled={busy}
                  mix={on('click', () => {
                    flushName()
                    onSave()
                  })}
                >
                  Save
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  mix={on('click', () => {
                    flushName()
                    onClose()
                  })}
                >
                  Done
                </button>
              </div>
              <p className="sheet-utility-links">
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  mix={on('click', () => {
                    flushName()
                    onSaveClips()
                  })}
                >
                  Save original clips (.zip)
                </button>{' '}
                ·{' '}
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  mix={on('click', () => {
                    flushName()
                    onReExport()
                  })}
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
                    Location is off by default. MP4 exports credit kody.video and note the clip
                    count — never where you filmed, unless you turn this on. Share and Save stamp
                    the file date from the last clip so Photos apps can sort. Chapter markers stay
                    in the video either way.
                  </p>
                </div>
              ) : null}
            </>
          ) : null}

          {status === 'error' ? (
            <>
              <h3>Export hit a snag</h3>
              <p className="sheet-message is-error">{error ?? 'Something went wrong.'}</p>
              {brokenClips.length > 0 ? (
                <ul className="export-broken-clips" aria-label="Clips with no video">
                  {brokenClips.map((clip) => (
                    <li key={clip.clipId} className="export-broken-clip">
                      {clip.thumb ? (
                        <TimelineThumbImage blob={clip.thumb} className="export-broken-thumb" />
                      ) : (
                        <span className="export-broken-thumb" aria-hidden="true" />
                      )}
                      <span>Clip {clip.position}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {showFallbackHint
                ? fallbackHint({
                    busy,
                    onSaveBackup: () => {
                      flushName()
                      onSaveBackup()
                    },
                    onDismiss: () => {
                      fallbackHintDismissed = true
                      void handle.update()
                    },
                  })
                : null}
              {notice ? <p className="sheet-message">{notice}</p> : null}
              <div className="sheet-actions">
                {brokenClips.length > 0 ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    mix={on('click', () => onDeleteBrokenClips())}
                  >
                    {deleteUnexportableClipsLabel(brokenClips.map((clip) => clip.position))}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    mix={on('click', () => onRetry())}
                  >
                    Try again
                  </button>
                )}
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
  const type = ext === 'webm' ? 'WebM' : ext ? ext.toUpperCase() : 'Video'
  if (bytes === null) return type
  const mb = bytes / (1024 * 1024)
  return `${type} · ${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`
}
