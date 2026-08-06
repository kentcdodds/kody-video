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
  /**
   * True once this run entered the realtime canvas + MediaRecorder path.
   * Shows a dismissible compatibility notice (session-only; resets next export).
   */
  usedFallback: boolean
  /** Bound to the canvas the export engines mirror sampled frames onto. */
  bindPreviewCanvas: (canvas: HTMLCanvasElement | null) => void
}

/**
 * Full-screen export progress, OK Video style: the camera/editor is hidden
 * (and the camera released) while the engines show the frame currently
 * being encoded above a big progress bar.
 */
export function ExportOverlay(handle: Handle<ExportOverlayProps>) {
  let fallbackNoticeDismissed = false

  return () => {
    const { projectName, progress, watermarked, usedFallback } = handle.props
    const percent = Math.round(progress * 100)
    const showFallbackNotice = usedFallback && !fallbackNoticeDismissed
    return (
      <div className="export-overlay" role="dialog" aria-label="Exporting video">
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
            {watermarked ? ' · includes the Kody mark' : ''}
          </p>
          <div className="progress-bar" aria-label="Export progress">
            <span style={{ width: `${percent}%` }} />
          </div>
          <p className="export-percent" aria-live="polite">
            {percent}%
          </p>
        </div>
      </div>
    )
  }
}
