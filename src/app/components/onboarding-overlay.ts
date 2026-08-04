import { define, h, KvElement } from '../dom.ts'
import { brandMark } from './brand-mark.ts'

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

export interface OnboardingOverlayProps {
  onDismiss: () => void
}

export class KvOnboardingOverlay extends KvElement<OnboardingOverlayProps> {
  override render(): void {
    const card = h(
      'div',
      { className: 'onboarding-card' },
      h(
        'div',
        { className: 'onboarding-card-top' },
        brandMark({ size: 72, className: 'brand-mark onboarding-art', variant: 'camera' }),
        h(
          'div',
          null,
          h('p', { className: 'eyebrow' }, 'Quick start'),
          h('h2', null, 'Camera first. Fun second.'),
        ),
      ),
      h(
        'ol',
        null,
        steps.map((step, index) =>
          h(
            'li',
            null,
            h('span', null, String(index + 1)),
            h('div', null, h('strong', null, step.title), h('p', null, step.body)),
          ),
        ),
      ),
      h(
        'button',
        { type: 'button', className: 'btn btn-primary', onclick: () => this.props.onDismiss() },
        'Start recording',
      ),
    )
    this.replaceChildren(
      h(
        'div',
        { className: 'onboarding-overlay', role: 'dialog', 'aria-label': 'Kody Video quick start' },
        card,
      ),
    )
  }
}
define('kv-onboarding-overlay', KvOnboardingOverlay)
