import type { Handle } from 'remix/ui'
import { on, ref } from 'remix/ui'

interface ExportOverlayProps {
  projectName: string
  progress: number
  /**
   * True when this export stamps the Kody mark. Engines draw it onto every
   * encoded frame before mirroring to the preview canvas, so the live
   * preview matches the final video.
   */
  watermarked: boolean
  /** True when this run will write captured coordinates into the MP4. */
  locationIncluded: boolean
  /**
   * True once this run entered the realtime canvas + MediaRecorder path.
   * Shows a dismissible compatibility notice (session-only; resets next export).
   */
  usedFallback: boolean
  /** Plus unlocked — mark/location prefs can change mid-export. */
  purchased: boolean
  keepWatermark: boolean
  includeLocation: boolean
  hasTaggedClips: boolean
  /** Bound to the canvas the export engines mirror sampled frames onto. */
  bindPreviewCanvas: (canvas: HTMLCanvasElement | null) => void
  onStop: () => void
  onKeepWatermarkChange: (keep: boolean) => void
  onIncludeLocationChange: (include: boolean) => void
}

/**
 * Full-screen export progress, OK Video style: the camera/editor is hidden
 * (and the camera released) while the engines show the frame currently
 * being encoded above a big progress bar.
 */
export function ExportOverlay(handle: Handle<ExportOverlayProps>) {
  let fallbackNoticeDismissed = false

  return () => {
    const {
      projectName,
      progress,
      watermarked,
      locationIncluded,
      usedFallback,
      purchased,
      keepWatermark,
      includeLocation,
      hasTaggedClips,
      onStop,
      onKeepWatermarkChange,
      onIncludeLocationChange,
    } = handle.props
    const percent = Math.round(progress * 100)
    const showFallbackNotice = usedFallback && !fallbackNoticeDismissed
    const statusBits = [
      watermarked ? 'includes the Kody mark' : null,
      locationIncluded ? 'includes clip locations' : null,
    ].filter((bit): bit is string => bit !== null)
    return (
      <div
        className="export-overlay"
        role="dialog"
        aria-label="Exporting video"
        mix={ref((_node, signal) => {
          const onKey = (event: KeyboardEvent) => {
            if (event.code === 'Escape') {
              event.preventDefault()
              handle.props.onStop()
            }
          }
          window.addEventListener('keydown', onKey)
          signal.addEventListener('abort', () => {
            window.removeEventListener('keydown', onKey)
          })
        })}
      >
        <div className="export-overlay-stage">
          <canvas
            className="export-preview-canvas"
            mix={ref((node, signal) => {
              handle.props.bindPreviewCanvas(node as HTMLCanvasElement)
              signal.addEventListener('abort', () => handle.props.bindPreviewCanvas(null))
            })}
          />
        </div>
        <div className="export-overlay-info">
          {showFallbackNotice ? (
            <div className="export-fallback-notice" role="status">
              <p>
                This device is using a compatibility export — slower and more limited than usual.
                When it finishes, you can save a project backup and export on a computer for higher
                quality.
              </p>
              <button
                type="button"
                className="link-button"
                mix={on('click', () => {
                  fallbackNoticeDismissed = true
                  void handle.update()
                })}
              >
                Dismiss
              </button>
            </div>
          ) : null}
          <h2>Exporting your video…</h2>
          <p className="muted">
            {projectName} — keep the app open
            {statusBits.length > 0 ? ` · ${statusBits.join(' · ')}` : ''}
          </p>
          <div className="progress-bar" aria-label="Export progress">
            <span style={{ width: `${percent}%` }} />
          </div>
          <p className="export-percent" aria-live="polite">
            {percent}%
          </p>
          {purchased ? (
            <div className="export-overlay-prefs">
              <label className="export-pref-toggle">
                <input
                  type="checkbox"
                  checked={keepWatermark}
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
                  mix={on('change', (event) => {
                    onIncludeLocationChange((event.currentTarget as HTMLInputElement).checked)
                  })}
                />
                Include clip locations in MP4 exports
              </label>
              {hasTaggedClips ? (
                <p className="export-overlay-pref-hint muted">
                  Changing a setting stops this export and starts a new one.
                </p>
              ) : (
                <p className="export-overlay-pref-hint muted">
                  Changing the mark setting stops this export and starts a new one.
                </p>
              )}
            </div>
          ) : null}
          <button
            type="button"
            className="btn btn-secondary export-overlay-stop"
            aria-label="Stop export"
            mix={on('click', () => onStop())}
          >
            Stop
          </button>
        </div>
      </div>
    )
  }
}
