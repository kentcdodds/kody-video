import type { Handle } from 'remix/component'
import { on } from 'remix/component'
import {
  EXPORT_SIZE_LABEL,
  exportSizeCaption,
  type ExportSizeOption,
} from '../lib/export/export-size'
import { formatBytes } from '../lib/storage-space'
import type { ExportSize } from '../lib/types'

interface ExportSizePickerProps {
  options: readonly ExportSizeOption[]
  value: ExportSize
  /** Real size of the finished file, shown on the selected option instead
   * of its estimate (Done sheet). */
  actualBytes?: number | null
  disabled?: boolean
  onChange: (next: ExportSize) => void
}

/** Segmented Full / 720p / 480p control with a size estimate per option. */
export function ExportSizePicker(handle: Handle<ExportSizePickerProps>) {
  return () => {
    const { options, value, actualBytes, disabled, onChange } = handle.props
    const selected = options.find((option) => option.id === value) ?? options[0]
    if (!selected) return null
    // Once a file exists, scale the other estimates by how far the real file
    // landed from its own estimate (simple footage compresses well below the
    // bitrate budget), so the options stay comparable.
    const calibration =
      actualBytes && selected.estimatedBytes > 0 ? actualBytes / selected.estimatedBytes : 1
    return (
      <div className="video-quality-picker export-size-picker">
        <div className="video-quality-options" role="radiogroup" aria-label="Export size">
          {options.map((option) => {
            const active = option.id === selected.id
            const bytes =
              active && actualBytes ? actualBytes : option.estimatedBytes * calibration
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled}
                className={`video-quality-option export-size-option${active ? ' is-active' : ''}`}
                mix={on('click', () => {
                  if (!active) onChange(option.id)
                })}
              >
                <span>{EXPORT_SIZE_LABEL[option.id]}</span>
                <span className="export-size-bytes">
                  {active && actualBytes ? '' : '~'}
                  {formatBytes(bytes)}
                </span>
              </button>
            )
          })}
        </div>
        <p className="video-quality-hint">{exportSizeCaption(selected)}</p>
      </div>
    )
  }
}
