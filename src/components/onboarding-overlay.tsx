import type { Handle } from 'remix/ui'
import { on } from 'remix/ui'
import { BrandMark } from './brand-mark'
import { IconPlay } from './icons'

interface OnboardingOverlayProps {
  onDismiss: () => void
}

/**
 * Promo/tour video, self-hosted on R2 behind the site's own domain (no
 * third-party player, no tracking). Streamed only when the user taps play —
 * the card itself costs nothing but the precached poster.
 */
const TOUR_VIDEO_URL = 'https://media.kody.video/promo/kody-video-promo-v1.mp4'
const TOUR_POSTER_URL = '/art/kody-video-tour-poster.webp'

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
    body: 'Backspace deletes the last clip (with Undo). Timeline opens the editor to trim or reorder.',
  },
  {
    title: 'Tap Go',
    body: 'Exports one video on-device, then Share or Save. Nothing leaves this phone until you choose.',
  },
]

export function OnboardingOverlay(handle: Handle<OnboardingOverlayProps>) {
  let tourPlaying = false
  return () => (
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
        {tourPlaying ? (
          <video
            className="onboarding-tour-video"
            src={TOUR_VIDEO_URL}
            poster={TOUR_POSTER_URL}
            controls
            autoPlay
            playsInline
          />
        ) : (
          <button
            type="button"
            className="onboarding-tour"
            mix={on('click', () => {
              tourPlaying = true
              void handle.update()
            })}
          >
            <img src={TOUR_POSTER_URL} alt="" width={44} height={78} />
            <div>
              <strong>Watch the tour</strong>
              <p>Kent demos the whole flow in a minute and a half.</p>
            </div>
            <IconPlay />
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary"
          mix={on('click', () => handle.props.onDismiss())}
        >
          Start recording
        </button>
      </div>
    </div>
  )
}
