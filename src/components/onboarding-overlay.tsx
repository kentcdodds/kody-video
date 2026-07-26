import { BrandMark } from './brand-mark'

interface OnboardingOverlayProps {
  onDismiss: () => void
}

const steps = [
  {
    title: 'Hold to record',
    body: 'Press anywhere on the live preview. Release to append a clip.',
  },
  {
    title: 'Preview the take',
    body: 'Open Editor to scrub clips, trim rough edges, and check the sequence.',
  },
  {
    title: 'Delete fast',
    body: 'Use Delete last after a bad take. The snackbar gives you Undo.',
  },
  {
    title: 'Tap OK',
    body: 'The round OK button exports or shares from this device. No uploads.',
  },
]

export function OnboardingOverlay({ onDismiss }: OnboardingOverlayProps) {
  return (
    <div className="onboarding-overlay" role="dialog" aria-label="Kody Video quick start">
      <div className="onboarding-card">
        <BrandMark size={58} className="brand-mark" />
        <p className="eyebrow">Kody Video quick start</p>
        <h2>Camera first. Editor second.</h2>
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
