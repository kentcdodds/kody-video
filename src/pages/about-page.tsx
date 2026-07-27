import { Link } from 'react-router-dom'
import { BrandMark } from '../components/brand-mark'

/** Credits, inspiration, and the open-source pointer. */
export function AboutPage() {
  return (
    <div className="screen about-screen">
      <div className="about-top">
        <Link to="/" className="btn-icon" aria-label="Back to projects">
          ←
        </Link>
        <strong>About</strong>
        <span className="about-top-spacer" aria-hidden="true" />
      </div>

      <div className="about-body">
        <div className="about-hero" aria-hidden="true">
          <BrandMark size={96} className="brand-hero-art" variant="icon" />
        </div>
        <h1>
          Kody <span>Video</span>
        </h1>

        <section className="about-section">
          <h2>Free &amp; open source</h2>
          <p>
            Kody Video is open source — the whole app, including the export engine, lives at{' '}
            <a
              href="https://github.com/kentcdodds/kody-video"
              target="_blank"
              rel="noreferrer noopener"
            >
              github.com/kentcdodds/kody-video
            </a>
            . Issues, ideas, and pull requests are welcome.
          </p>
        </section>

        <section className="about-section">
          <h2>Inspired by OK Video</h2>
          <p>
            This app exists because of{' '}
            <a href="https://okvideo.app" target="_blank" rel="noreferrer noopener">
              OK Video
            </a>{' '}
            by Pim Coumans — a wonderful hold-to-record clips camera for iPhone and a heavy source
            of inspiration for Kody Video&rsquo;s whole interaction model. If you&rsquo;re on iOS,
            go get the real thing. Kody Video is an independent project and is not affiliated with
            OK Video.
          </p>
        </section>

        <section className="about-section">
          <h2>Kody the koala</h2>
          <p>
            The mascot comes from the KCD community —{' '}
            <a href="https://kentcdodds.com/kody" target="_blank" rel="noreferrer noopener">
              kentcdodds.com/kody
            </a>
            .
          </p>
        </section>

        <section className="about-section">
          <h2>Private by design</h2>
          <p>
            No accounts, no analytics, no uploads. Clips live in this browser&rsquo;s storage until
            you export and share them yourself. The only network calls are Stripe checkout and its
            purchase verification if you buy the watermark removal.
          </p>
        </section>
      </div>
    </div>
  )
}
