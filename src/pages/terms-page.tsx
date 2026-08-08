import { IconBack } from '../components/icons'

/** Plain-language terms of use for on-device Kody Video. */
export function TermsPage() {
  return () => (
    <div className="screen about-screen">
      <div className="about-top">
        <a href="/" className="btn-icon" aria-label="Back to projects">
          <IconBack />
        </a>
        <strong>Terms</strong>
        <span className="about-top-spacer" aria-hidden="true" />
      </div>

      <div className="about-body">
        <h1>Terms</h1>
        <p className="legal-updated">Last updated: July 2026</p>

        <section className="about-section">
          <h2>Free to use, as is</h2>
          <p>
            Kody Video is free to use and runs entirely on your device. It is provided &ldquo;as
            is&rdquo; without warranty of any kind. Use it at your own risk — always keep copies of
            recordings you care about. Device storage can be cleared by the browser or OS.
          </p>
        </section>

        <section className="about-section">
          <h2>Your recordings are yours</h2>
          <p>
            You own your recordings entirely. The app claims no rights to any of your content.
          </p>
        </section>

        <section className="about-section">
          <h2>Kody Video Plus</h2>
          <p>
            Kody Video Plus is a one-time $0.99 purchase that unlocks watermark-free exports,
            optional location tagging, and up to six project slots (the free plan includes one
            project) for the browser profile where it&rsquo;s verified. You can restore the
            purchase on another device via the Stripe receipt link. Payments are handled by Stripe.
            For refunds or purchase trouble, email{' '}
            <a href="mailto:team@kody.video">team@kody.video</a>.
          </p>
        </section>

        <section className="about-section">
          <h2>Recording responsibly</h2>
          <p>
            Don&rsquo;t use the app to record people unlawfully. You are responsible for complying
            with local recording and consent laws.
          </p>
        </section>

        <section className="about-section">
          <h2>Liability</h2>
          <p>
            Liability is limited to the amount you paid for the app — at most $0.99.
          </p>
        </section>

        <section className="about-section">
          <h2>Changes &amp; affiliation</h2>
          <p>
            These terms may change with the app; they&rsquo;re versioned in the{' '}
            <a
              href="https://github.com/kentcdodds/kody-video"
              target="_blank"
              rel="noreferrer noopener"
            >
              open-source repo
            </a>
            . Kody Video is not affiliated with OK Video.
          </p>
        </section>

        <section className="about-section legal-nav">
          <p>
            See also the <a href="/privacy">Privacy</a> and <a href="/about">About</a> pages.
          </p>
        </section>
      </div>
    </div>
  )
}
