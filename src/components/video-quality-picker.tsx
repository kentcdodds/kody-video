import type { Handle } from 'remix/ui'
import { on } from 'remix/ui'
import {
  VIDEO_QUALITY_IDS,
  VIDEO_QUALITY_PRESETS,
  type VideoQualityPreset,
} from '../lib/video-quality'
import { IconLock } from './icons'

interface VideoQualityPickerProps {
  value: VideoQualityPreset
  onChange: (next: VideoQualityPreset) => void
  /** High (1080p) is a Plus perk; free taps open the upsell. `null` means
   * entitlement is still loading — High is not locked and nothing is
   * tappable, so a Plus user never sees a false upsell on first paint. */
  plus: boolean | null
  onUpsell: () => void
  /** Tighter chips for the home storage popover. */
  compact?: boolean
}

/** Segmented High / Standard / Saver control. 30fps in every option. */
export function VideoQualityPicker(handle: Handle<VideoQualityPickerProps>) {
  return () => {
    const { value, onChange, plus, onUpsell, compact } = handle.props
    const ready = plus !== null
    const selected = VIDEO_QUALITY_PRESETS[value]
    return (
      <div className={`video-quality-picker${compact ? ' is-compact' : ''}`}>
        <div
          className="video-quality-options"
          role="radiogroup"
          aria-label="Video quality"
          aria-busy={!ready}
        >
          {VIDEO_QUALITY_IDS.map((id) => {
            const locked = id === 'high' && plus === false
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={value === id}
                aria-label={locked ? 'High (Kody Video Plus)' : undefined}
                disabled={!ready}
                className={`video-quality-option${value === id ? ' is-active' : ''}${locked ? ' is-locked' : ''}`}
                mix={on('click', () => {
                  if (!ready) return
                  if (locked) {
                    onUpsell()
                    return
                  }
                  if (id !== value) onChange(id)
                })}
              >
                {VIDEO_QUALITY_PRESETS[id].label}
                {locked ? (
                  <span className="video-quality-lock" aria-hidden="true">
                    <IconLock size={12} />
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
        <p className="video-quality-hint">{selected.hint}</p>
      </div>
    )
  }
}
