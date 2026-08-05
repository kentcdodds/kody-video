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

/** First-timer home card: tap-to-play tour video with a persistent dismiss. */
export function TourCard(handle: Handle<TourCardProps>) {
  let playing = false
  let video: HTMLVideoElement | null = null
  return () => (
    <section className="tour-card" aria-label="Kody Video tour">
      {/* Mounted (hidden) before the teaser is tapped so play() can run
          inside the tap's gesture — mobile browsers block unmuted playback
          that starts after an async re-render. */}
      <video
        className={playing ? 'tour-card-video' : 'visually-hidden'}
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
      {playing ? null : (
        <button
          type="button"
          className="tour-card-teaser"
          mix={on('click', () => {
            playing = true
            // In-gesture play() is what mobile autoplay policies require
            // for sound. If it still rejects, the controls are visible.
            void video?.play().catch(() => {})
            void handle.update()
            // The activated teaser button is about to disappear — hand
            // keyboard focus to the player so its controls stay reachable.
            requestAnimationFrame(() => {
              video?.focus()
            })
          })}
        >
          <img src={TOUR_POSTER_URL} alt="" width={44} height={78} />
          <span className="tour-card-copy">
            <strong>New here? Watch the tour</strong>
            <span>Kent demos the whole flow — record, arrange, share — in a minute and a half.</span>
          </span>
          <IconPlay />
        </button>
      )}
      <button
        type="button"
        className="install-hint-dismiss tour-card-dismiss"
        aria-label="Dismiss tour"
        mix={on('click', () => handle.props.onDismiss())}
      >
        <IconClose size={16} />
      </button>
    </section>
  )
}
