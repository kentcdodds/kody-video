import type { Handle } from 'remix/component'
import { on } from 'remix/component'
import {
  EXPORT_FORMAT_HINT,
  EXPORT_FORMAT_IDS,
  EXPORT_FORMAT_LABEL,
  EXPORT_FORMAT_UNAVAILABLE,
  type ExportFormatSupport,
} from '../lib/export/export-format'
import type { ExportFormat } from '../lib/types'

interface ExportFormatPickerProps {
  /** Container the next export will use. */
  value: ExportFormat
  /** Null while the encoder probe is still running. */
  support: ExportFormatSupport | null
  /** Extension of the finished file, when it differs from `value`. */
  actual?: string | null
  disabled?: boolean
  onChange: (next: ExportFormat) => void
}

/** Segmented MP4 / WebM control; formats this browser can't encode are disabled. */
export function ExportFormatPicker(handle: Handle<ExportFormatPickerProps>) {
  return () => {
    const { value, support, actual, disabled, onChange } = handle.props
    const unavailable = support ? EXPORT_FORMAT_IDS.find((id) => !support[id]) : undefined
    const fellBack = actual && actual !== value ? actual : null
    return (
      <div className="video-quality-picker export-format-picker">
        <div className="video-quality-options" role="radiogroup" aria-label="Export format">
          {EXPORT_FORMAT_IDS.map((id) => {
            const active = id === value
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled || id === unavailable}
                className={`video-quality-option${active ? ' is-active' : ''}`}
                mix={on('click', () => {
                  if (!active) onChange(id)
                })}
              >
                {EXPORT_FORMAT_LABEL[id]}
              </button>
            )
          })}
        </div>
        <p className="video-quality-hint">
          {fellBack
            ? `This file is ${fellBack.toUpperCase()}: ${EXPORT_FORMAT_LABEL[value]} couldn’t be encoded here.`
            : unavailable
              ? EXPORT_FORMAT_UNAVAILABLE[unavailable]
              : EXPORT_FORMAT_HINT[value]}
        </p>
      </div>
    )
  }
}
