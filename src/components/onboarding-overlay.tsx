import { BrandMark } from './brand-mark'

interface OnboardingOverlayProps {
  onDismiss: () => void
}

const steps = [
  {
    title: 'Hold to record',
    body: 'Press anywhere on the camera. Release to stop and append a clip.',
  },
  {
    title: 'Preview',
    body: 'Tap the play button to watch your cut. Tap the edges to skip clips.',
  },
  {
    title: 'Fix mistakes fast',
    body: 'Backspace deletes the last clip (with Undo). Scissors opens the editor to trim or reorder.',
  },
  {
    title: 'Tap Go',
    body: 'Exports one video on-device, then Share or Save. Nothing leaves this phone until you choose.',
  },
]

export function OnboardingOverlay({ onDismiss }: OnboardingOverlayProps) {
  return (
    <div className="onboarding-overlay" role="dialog" aria-label="Kody Video quick start">
      <div className="onboarding-card">
        <div className="onboarding-card-top">
          <BrandMark size={72} className="brand-mark onboarding-art" variant="camera" />
          <div>
            <p className="eyebrow">Quick start</p>
            <h2>Camera first. Fun second.</h2>
          </div>
        </div>
        <ol>
          {steps.map((step, index) => (
            <li key={step.title}>
              <span>{index + 1}</span>
              <div>
                <strong>{step.title}</strong>
                <p>{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <button type="button" className="btn btn-primary" onClick={onDismiss}>
          Start recording
        </button>
      </div>
    </div>
  )
}
