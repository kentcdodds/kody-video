import type { Handle } from 'remix/ui'
import { on } from 'remix/ui'
import {
  VIDEO_QUALITY_IDS,
  VIDEO_QUALITY_PRESETS,
  type VideoQualityPreset,
} from '../lib/video-quality'

interface VideoQualityPickerProps {
  value: VideoQualityPreset
  onChange: (next: VideoQualityPreset) => void
  /** Tighter chips for the home storage popover. */
  compact?: boolean
}

/** Segmented High / Standard / Saver control. 30fps in every option. */
export function VideoQualityPicker(handle: Handle<VideoQualityPickerProps>) {
  return () => {
    const { value, onChange, compact } = handle.props
    const selected = VIDEO_QUALITY_PRESETS[value]
    return (
      <div className={`video-quality-picker${compact ? ' is-compact' : ''}`}>
        <div className="video-quality-options" role="radiogroup" aria-label="Video quality">
          {VIDEO_QUALITY_IDS.map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={value === id}
              className={`video-quality-option${value === id ? ' is-active' : ''}`}
              mix={on('click', () => {
                if (id !== value) onChange(id)
              })}
            >
              {VIDEO_QUALITY_PRESETS[id].label}
            </button>
          ))}
        </div>
        <p className="video-quality-hint">{selected.hint}</p>
      </div>
    )
  }
}
