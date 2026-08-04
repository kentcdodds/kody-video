import type { Handle } from 'remix/ui'
import { ref } from 'remix/ui'

interface ExportOverlayProps {
  projectName: string
  progress: number
  /** Bound to the canvas the export engines mirror sampled frames onto. */
  bindPreviewCanvas: (canvas: HTMLCanvasElement | null) => void
}

/**
 * Full-screen export progress, OK Video style: the camera/editor is hidden
 * (and the camera released) while the engines show the frame currently
 * being encoded above a big progress bar.
 */
export function ExportOverlay(handle: Handle<ExportOverlayProps>) {
  return () => {
    const { projectName, progress } = handle.props
    const percent = Math.round(progress * 100)
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
          <h2>Exporting your video…</h2>
          <p className="muted">{projectName} — keep the app open</p>
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
