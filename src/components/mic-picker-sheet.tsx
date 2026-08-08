import type { Handle } from 'remix/ui'
import { on, ref } from 'remix/ui'
import type { AudioInputOption } from '../lib/audio-input'
import { attachSheetModal } from '../lib/sheet-modal'

interface MicPickerSheetProps {
  inputs: AudioInputOption[]
  /** Mic upcoming takes record from (null = system default, no highlight). */
  activeId: string | null
  onPick: (id: string) => void
  onClose: () => void
}

/** Bottom sheet listing microphones — shown when the device has more than one. */
export function MicPickerSheet(handle: Handle<MicPickerSheetProps>) {
  return () => {
    const { inputs, activeId, onPick, onClose } = handle.props
    return (
      <>
        <div className="sheet-backdrop" mix={on('click', () => onClose())} />
        <div
          className="sheet mic-picker-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Choose a microphone"
          mix={ref((node, signal) =>
            attachSheetModal(node as HTMLElement, signal, {
              onDismiss: () => handle.props.onClose(),
            }),
          )}
        >
          <h3>Microphone</h3>
          <p className="sheet-lede muted">New recordings use the selected mic.</p>
          <div className="mic-options" role="group" aria-label="Microphones">
            {inputs.map((input, index) => {
              const isActive = input.id === activeId
              return (
                <button
                  key={input.id}
                  type="button"
                  className={`mic-option-btn${isActive ? ' is-active' : ''}`}
                  aria-pressed={isActive}
                  mix={on('click', () => onPick(input.id))}
                >
                  {/* Labels are empty until mic permission is granted. */}
                  <span className="mic-option-label">
                    {input.label || `Microphone ${index + 1}`}
                  </span>
                  {isActive ? (
                    <span className="mic-option-check" aria-hidden="true">
                      ✓
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
          <div className="sheet-actions">
            <button type="button" className="btn btn-ghost" mix={on('click', () => onClose())}>
              Cancel
            </button>
          </div>
        </div>
      </>
    )
  }
}
