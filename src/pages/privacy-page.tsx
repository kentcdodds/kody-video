import { Link } from 'react-router-dom'

/** Plain-language privacy policy for on-device Kody Video. */
export function PrivacyPage() {
  return (
    <div className="screen about-screen">
      <div className="about-top">
        <Link to="/" className="btn-icon" aria-label="Back to projects">
          ←
        </Link>
        <strong>Privacy</strong>
        <span className="about-top-spacer" aria-hidden="true" />
      </div>

      <div className="about-body">
        <h1>Privacy</h1>
        <p className="legal-updated">Last updated: July 2026</p>

        <section className="about-section">
          <h2>Everything stays on your device</h2>
          <p>
            All recordings, projects, and edits live in this browser&rsquo;s on-device storage
            (IndexedDB). Nothing is uploaded. There are no accounts, no analytics, no tracking, and
            no cookies beyond what the browser itself does.
          </p>
        </section>

        <section className="about-section">
          <h2>Camera &amp; microphone</h2>
          <p>
            The camera and microphone are used only while the app is open and you are recording.
            Backgrounding the app releases them.
          </p>
        </section>

        <section className="about-section">
          <h2>Optional location tagging</h2>
          <p>
            Location tagging is off by default. You can opt in with a button, which asks the
            browser for permission. When it&rsquo;s on, each new clip stores device coordinates
            locally, and exported videos embed that location in their metadata and chapter titles.
            Sharing such a video shares those coordinates. You can turn location tagging off anytime;
            existing clips keep whatever they already captured, and deleting a clip deletes its
            location data with it.
          </p>
        </section>

        <section className="about-section">
          <h2>Watermark removal purchase</h2>
          <p>
            The one-time watermark-removal purchase is processed by Stripe on Stripe&rsquo;s pages
            — their privacy policy applies. The app&rsquo;s verification endpoint sees only the
            checkout session id, never your media or location.
          </p>
        </section>

        <section className="about-section">
          <h2>Exports &amp; sharing</h2>
          <p>
            Exported or shared files leave the device only when you share or save them yourself.
          </p>
        </section>

        <section className="about-section">
          <h2>Deleting your data</h2>
          <p>
            Delete projects in the app, or clear this site&rsquo;s browsing data / uninstall the
            PWA. There is no server copy to delete.
          </p>
        </section>

        <section className="about-section">
          <h2>Questions</h2>
          <p>
            Email <a href="mailto:team@kody.video">team@kody.video</a> or open an issue at{' '}
            <a
              href="https://github.com/kentcdodds/kody-video"
              target="_blank"
              rel="noreferrer noopener"
            >
              github.com/kentcdodds/kody-video
            </a>
            .
          </p>
        </section>

        <section className="about-section legal-nav">
          <p>
            See also the <Link to="/terms">Terms</Link> and{' '}
            <Link to="/about">About</Link> pages.
          </p>
        </section>
      </div>
    </div>
  )
}
