/** Plain-language privacy policy and terms for on-device Kody Video. */
import { define, fromHtml, h, KvElement } from "../dom.js";
import { iconBack } from "../components/icons.js";
function legalScreen(title, bodyHtml) {
    return h('div', { className: 'screen about-screen' }, h('div', { className: 'about-top' }, h('a', { href: '/', className: 'btn-icon', 'aria-label': 'Back to projects' }, iconBack()), h('strong', null, title), h('span', { className: 'about-top-spacer', 'aria-hidden': 'true' })), fromHtml(`<div class="about-body">${bodyHtml}</div>`));
}
export class KvPrivacyPage extends KvElement {
    render() {
        this.replaceChildren(legalScreen('Privacy', `
        <h1>Privacy</h1>
        <p class="legal-updated">Last updated: August 2026</p>
        <section class="about-section">
          <h2>Everything stays on your device</h2>
          <p>All recordings, projects, and edits live in this browser’s on-device storage
            (IndexedDB). Nothing is uploaded. There are no accounts, no cookies, no analytics,
            no crash reporting, and no cross-site tracking.</p>
        </section>
        <section class="about-section">
          <h2>Camera &amp; microphone</h2>
          <p>The camera and microphone are used only while the app is open, on the camera view.
            On most devices the microphone is held only while you record; on iOS it stays with
            the camera preview (a WebKit requirement for working audio). Backgrounding the app
            releases both. Nothing is ever streamed anywhere.</p>
        </section>
        <section class="about-section">
          <h2>Optional location tagging</h2>
          <p>Location tagging is off by default. You can opt in with a button, which asks the
            browser for permission. When it’s on, each new clip stores device coordinates
            locally, and exported videos embed that location in their metadata and chapter
            titles. Sharing such a video shares those coordinates. You can turn location tagging
            off anytime; existing clips keep whatever they already captured, and deleting a clip
            deletes its location data with it.</p>
        </section>
        <section class="about-section">
          <h2>Watermark removal purchase</h2>
          <p>The one-time watermark-removal purchase is processed by Stripe on Stripe’s pages —
            their privacy policy applies. The app’s verification endpoint sees only the checkout
            session id, never your media or location.</p>
        </section>
        <section class="about-section">
          <h2>Exports &amp; sharing</h2>
          <p>Exported or shared files leave the device only when you share or save them yourself.</p>
        </section>
        <section class="about-section">
          <h2>Deleting your data</h2>
          <p>Delete projects in the app, or clear this site’s browsing data / uninstall the PWA.
            There is no server copy to delete.</p>
        </section>
        <section class="about-section">
          <h2>Questions</h2>
          <p>Email <a href="mailto:team@kody.video">team@kody.video</a> or open an issue at
            <a href="https://github.com/kentcdodds/kody-video" target="_blank" rel="noreferrer noopener">github.com/kentcdodds/kody-video</a>.</p>
        </section>
        <section class="about-section legal-nav">
          <p>See also the <a href="/terms">Terms</a> and <a href="/about">About</a> pages.</p>
        </section>
        `));
    }
}
define('kv-privacy-page', KvPrivacyPage);
export class KvTermsPage extends KvElement {
    render() {
        this.replaceChildren(legalScreen('Terms', `
        <h1>Terms</h1>
        <p class="legal-updated">Last updated: August 2026</p>
        <section class="about-section">
          <h2>Free to use, as is</h2>
          <p>Kody Video is free to use and runs entirely on your device. It is provided “as is”
            without warranty of any kind. Use it at your own risk — always keep copies of
            recordings you care about. Device storage can be cleared by the browser or OS.</p>
        </section>
        <section class="about-section">
          <h2>Your recordings are yours</h2>
          <p>You own your recordings entirely. The app claims no rights to any of your content.</p>
        </section>
        <section class="about-section">
          <h2>Kody Video Plus</h2>
          <p>Kody Video Plus is a one-time $0.99 purchase that unlocks watermark-free exports and
            up to six project slots (the free plan includes one project) for the browser profile
            where it’s verified. You can restore the purchase on another device via the Stripe
            receipt link. Payments are handled by Stripe. For refunds or purchase trouble, email
            <a href="mailto:team@kody.video">team@kody.video</a>.</p>
        </section>
        <section class="about-section">
          <h2>Recording responsibly</h2>
          <p>Don’t use the app to record people unlawfully. You are responsible for complying
            with local recording and consent laws.</p>
        </section>
        <section class="about-section">
          <h2>Liability</h2>
          <p>Liability is limited to the amount you paid for the app — at most $0.99.</p>
        </section>
        <section class="about-section">
          <h2>Changes &amp; affiliation</h2>
          <p>These terms may change with the app; they’re versioned in the
            <a href="https://github.com/kentcdodds/kody-video" target="_blank" rel="noreferrer noopener">open-source repo</a>.
            Kody Video is not affiliated with OK Video.</p>
        </section>
        <section class="about-section legal-nav">
          <p>See also the <a href="/privacy">Privacy</a> and <a href="/about">About</a> pages.</p>
        </section>
        `));
    }
}
define('kv-terms-page', KvTermsPage);
