import type { Handle } from 'remix/ui'
import { on, ref } from 'remix/ui'
import { IconClose, IconPlay } from './icons'

/**
 * Promo/tour video, self-hosted on R2 behind the site's own domain (no
 * third-party player, no tracking). Streamed only when the user taps play —
 * the card itself costs nothing but the precached poster.
 */
const TOUR_VIDEO_URL = 'https://media.kody.video/promo/kody-video-promo-v1.mp4'
const TOUR_POSTER_URL = '/art/kody-video-tour-poster.webp'

interface TourCardProps {
  onDismiss: () => void
}

/**
 * First-timer home card: the teaser opens the tour in a native `<dialog>`
 * (top layer — the page layout underneath never reflows) with a persistent
 * dismiss on the card itself.
 */
export function TourCard(handle: Handle<TourCardProps>) {
  let dialog: HTMLDialogElement | null = null
  let video: HTMLVideoElement | null = null

  return () => (
    <section className="tour-card" aria-label="Kody Video tour">
      <button
        type="button"
        className="tour-card-teaser"
        mix={on('click', () => {
          // showModal() + play() in the same tap: the dialog needs no
          // re-render to appear, and mobile autoplay policies require the
          // unmuted play() to run inside the gesture. If play() still
          // rejects, the controls are right there.
          dialog?.showModal()
          void video?.play().catch(() => {})
        })}
      >
        <img src={TOUR_POSTER_URL} alt="" width={44} height={78} />
        <span className="tour-card-copy">
          <strong>New here? Watch the tour</strong>
          <span>Kent demos the whole flow — record, arrange, share — in a minute and a half.</span>
        </span>
        <IconPlay />
      </button>
      <button
        type="button"
        className="install-hint-dismiss tour-card-dismiss"
        aria-label="Dismiss tour"
        mix={on('click', () => handle.props.onDismiss())}
      >
        <IconClose size={16} />
      </button>
      <dialog
        className="tour-dialog"
        aria-label="Kody Video tour video"
        mix={[
          ref((node, signal) => {
            dialog = node as HTMLDialogElement
            signal.addEventListener('abort', () => {
              dialog = null
            })
          }),
          // Esc (native cancel) and every other close path land here — the
          // audio must never keep playing behind a closed dialog.
          on('close', () => video?.pause()),
          // The dialog has no padding, so clicks on the element itself can
          // only come from the ::backdrop — tap outside to close.
          on('click', (event) => {
            if (event.target === event.currentTarget) dialog?.close()
          }),
        ]}
      >
        <video
          className="tour-dialog-video"
          src={TOUR_VIDEO_URL}
          poster={TOUR_POSTER_URL}
          controls
          tabIndex={0}
          playsInline
          preload="none"
          mix={ref((node, signal) => {
            video = node as HTMLVideoElement
            signal.addEventListener('abort', () => {
              video = null
            })
          })}
        />
        <button
          type="button"
          className="btn-icon tour-dialog-close"
          aria-label="Close tour"
          mix={on('click', () => dialog?.close())}
        >
          <IconClose />
        </button>
      </dialog>
    </section>
  )
}
