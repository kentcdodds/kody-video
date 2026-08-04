/** Credits, inspiration, storage/cache tools, and diagnostics. */
import { define, fromHtml, h, KvElement } from "../dom.js";
import { checkForUpdates } from "../lib/app-update.js";
import { buildDateLabel, shortVersion } from "../lib/build-info.js";
import { reportError } from "../lib/error-reporting.js";
import { clearExportCache, estimateExportCacheBytes } from "../lib/export/export-cache.js";
import { listRearCameras } from "../lib/media.js";
import { estimateStorageSpace, formatBytes } from "../lib/storage-space.js";
import { brandMark } from "../components/brand-mark.js";
import { iconBack } from "../components/icons.js";
/** Prefilled GitHub issue so bug reports arrive with device context attached. */
function reportProblemUrl() {
    const body = [
        '## What happened?',
        '',
        '(describe the problem — what you tapped, what you expected, what you got)',
        '',
        '## Device info (auto-filled)',
        '',
        `- App URL: ${location.origin}`,
        `- User agent: ${navigator.userAgent}`,
        `- Screen: ${window.screen.width}×${window.screen.height} @${window.devicePixelRatio}x`,
        `- Installed as app: ${window.matchMedia('(display-mode: standalone)').matches ? 'yes' : 'no'}`,
    ].join('\n');
    const params = new URLSearchParams({ labels: 'bug', body });
    return `https://github.com/kentcdodds/kody-video/issues/new?${params}`;
}
const UPDATE_STATUS_LABEL = {
    checking: 'Checking…',
    current: "You're on the latest version.",
    updating: 'Update found — reloading…',
    downloading: 'Update found — still downloading. It will offer itself when ready.',
    unavailable: "Couldn't check right now (offline, or not running from a deployment).",
};
export class KvAboutPage extends KvElement {
    data = {
        storage: null,
        exportCacheBytes: 0,
    };
    updateStatus = 'idle';
    cacheStatus = null;
    clearingCache = false;
    cameraReport = null;
    inspectingCameras = false;
    mounted() {
        void this.refresh();
    }
    async refresh() {
        const [storage, exportCacheBytes] = await Promise.all([
            estimateStorageSpace(),
            estimateExportCacheBytes(),
        ]);
        this.data = { storage, exportCacheBytes };
        if (this.signal.aborted)
            return;
        this.update();
    }
    /**
     * On-device camera diagnostic: what the browser exposes varies wildly by
     * phone and Chrome build, and remote lens bugs are unresolvable without it.
     */
    async onInspectCameras() {
        if (this.inspectingCameras)
            return;
        this.inspectingCameras = true;
        this.update();
        let probe = null;
        try {
            probe = await navigator.mediaDevices.getUserMedia({ video: true });
            const track = probe.getVideoTracks()[0];
            const caps = track?.getCapabilities?.();
            const lines = [`Active camera: ${track?.label || '(no label)'}`];
            if (caps?.zoom && typeof caps.zoom.min === 'number') {
                lines.push(`Active zoom range: ${caps.zoom.min}–${caps.zoom.max}×`);
            }
            else {
                lines.push('Active zoom range: not exposed');
            }
            const rear = await listRearCameras();
            lines.push(`Detected rear lenses: ${rear.length}`);
            const devices = await navigator.mediaDevices.enumerateDevices();
            for (const device of devices) {
                if (device.kind !== 'videoinput')
                    continue;
                const facing = device.getCapabilities?.()?.facingMode;
                const facingLabel = Array.isArray(facing) && facing.length > 0 ? ` [${facing.join(', ')}]` : '';
                const rearMark = rear.includes(device.deviceId) ? ' — rear' : '';
                lines.push(`• ${device.label || '(no label)'}${facingLabel}${rearMark}`);
            }
            this.cameraReport = lines.join('\n');
        }
        catch (err) {
            this.cameraReport =
                err instanceof Error ? `Could not inspect: ${err.message}` : 'Could not inspect cameras.';
        }
        finally {
            probe?.getTracks().forEach((track) => {
                track.stop();
            });
            this.inspectingCameras = false;
            this.update();
        }
    }
    onClearExportCache() {
        if (this.clearingCache)
            return;
        this.clearingCache = true;
        this.update();
        void clearExportCache()
            .then((freedBytes) => {
            this.cacheStatus = `Freed ${formatBytes(freedBytes)}.`;
            void this.refresh();
        })
            .catch((err) => {
            reportError(err, 'clear-export-cache');
            this.cacheStatus =
                err instanceof Error ? err.message : 'Could not clear cached exports — try again.';
        })
            .finally(() => {
            this.clearingCache = false;
            this.update();
        });
    }
    onCheckForUpdates() {
        if (this.updateStatus === 'checking' || this.updateStatus === 'updating')
            return;
        this.updateStatus = 'checking';
        this.update();
        void checkForUpdates()
            .then((result) => {
            switch (result) {
                case 'updated':
                    this.updateStatus = 'updating';
                    return;
                case 'current':
                    this.updateStatus = 'current';
                    return;
                case 'downloading':
                    this.updateStatus = 'downloading';
                    return;
                case 'unavailable':
                    this.updateStatus = 'unavailable';
                    return;
                default:
                    throw new Error(`Unhandled update result: ${String(result)}`);
            }
        })
            .catch(() => {
            this.updateStatus = 'unavailable';
        })
            .finally(() => this.update());
    }
    render() {
        const { storage, exportCacheBytes } = this.data;
        const prose = fromHtml(`<div style="display: contents">
      <section class="about-section">
        <h2>Free &amp; open source</h2>
        <p>Kody Video is open source — the whole app, including the export engine, lives at
          <a href="https://github.com/kentcdodds/kody-video" target="_blank" rel="noreferrer noopener">github.com/kentcdodds/kody-video</a>.
          Issues, ideas, and pull requests are welcome. This deployment is the
          <strong>vanilla experiment</strong>: the same app re-implemented with web components and
          plain HTML/CSS/JavaScript — no framework, no build step, and no dependency besides
          <a href="https://mediabunny.dev" target="_blank" rel="noreferrer noopener">Mediabunny</a>.</p>
      </section>
      <section class="about-section">
        <h2>Inspired by OK Video</h2>
        <p>This app exists because of
          <a href="https://okvideo.app" target="_blank" rel="noreferrer noopener">OK Video</a>
          by Pim Coumans — a wonderful hold-to-record clips camera for iPhone and a heavy source of
          inspiration for Kody Video’s whole interaction model. If you’re on iOS, go get the real
          thing. Kody Video is an independent project and is not affiliated with OK Video.</p>
      </section>
      <section class="about-section">
        <h2>Kody the koala</h2>
        <p>The mascot comes from the KCD community —
          <a href="https://kentcdodds.com/kody" target="_blank" rel="noreferrer noopener">kentcdodds.com/kody</a>.</p>
      </section>
      <section class="about-section">
        <h2>Private by design</h2>
        <p>No accounts, no uploads, no cross-site tracking, no analytics, no crash reporting.
          Clips live in this browser’s storage until you export and share them yourself. The app’s
          only own network traffic: Stripe checkout and its purchase verification if you buy the
          watermark removal.</p>
      </section>
      <section class="about-section">
        <h2>Made for phones</h2>
        <p>Kody Video is designed as a mobile camera app — install it on your phone for the real
          experience. It works on desktop too, with keyboard support: hold <kbd>Space</kbd> to
          record, <kbd>F</kbd> flips the camera, <kbd>T</kbd> starts the self-timer, <kbd>E</kbd>
          opens the editor, <kbd>P</kbd> plays your cut, and <kbd>Delete</kbd> removes the last
          clip. In the editor the arrow keys select clips, <kbd>Alt</kbd>+arrows reorder,
          <kbd>T</kbd> trims, <kbd>D</kbd> duplicates, <kbd>Delete</kbd> deletes, and
          <kbd>Esc</kbd> goes back. During playback the arrows skip clips, <kbd>Space</kbd>
          pauses, and <kbd>Esc</kbd> closes.</p>
      </section>
      </div>`);
        this.replaceChildren(h('div', { className: 'screen about-screen' }, h('div', { className: 'about-top' }, h('a', { href: '/', className: 'btn-icon', 'aria-label': 'Back to projects' }, iconBack()), h('strong', null, 'About'), h('span', { className: 'about-top-spacer', 'aria-hidden': 'true' })), h('div', { className: 'about-body' }, h('div', { className: 'about-hero', 'aria-hidden': 'true' }, brandMark({ size: 96, className: 'brand-hero-art', variant: 'icon' })), h('h1', null, 'Kody ', h('span', null, 'Video')), prose, h('section', { className: 'about-section' }, h('h2', null, 'Storage'), h('p', null, storage
            ? `This app uses ${formatBytes(storage.usedBytes)} of the ${formatBytes(storage.quotaBytes)} the browser allows. `
            : '', 'Your recordings are the big consumer — delete old projects from the home screen ' +
            '(⋯ → Delete) to free the most space. The app also keeps your latest export cached ' +
            'so tapping Go on an unchanged project is instant.'), h('p', null, 'Cached export files: ', h('strong', null, formatBytes(exportCacheBytes)), exportCacheBytes > 0
            ? [
                ' · ',
                h('button', {
                    type: 'button',
                    className: 'link-button',
                    disabled: this.clearingCache,
                    onclick: () => this.onClearExportCache(),
                }, 'Clear'),
            ]
            : null), this.cacheStatus ? h('p', { role: 'status', 'aria-live': 'polite' }, this.cacheStatus) : null), h('section', { className: 'about-section' }, h('h2', null, 'Cameras'), h('p', null, 'Wondering why a lens or zoom level isn’t available? Browsers expose cameras very ' +
            'differently across phones — ', h('button', {
            type: 'button',
            className: 'link-button',
            disabled: this.inspectingCameras,
            onclick: () => void this.onInspectCameras(),
        }, this.inspectingCameras ? 'Inspecting…' : 'Inspect cameras'), ' shows exactly what this browser reports (nothing is sent anywhere — attach it to a ' +
            'bug report if something looks wrong).'), this.cameraReport ? h('pre', { className: 'camera-report' }, this.cameraReport) : null), h('section', { className: 'about-section' }, h('h2', null, 'Support'), h('p', null, 'Hit a bug? Please ', h('a', { href: reportProblemUrl(), target: '_blank', rel: 'noreferrer noopener' }, 'open an issue on GitHub'), ' — the link pre-fills your device details so you only have to describe what went ' +
            'wrong. Prefer email (or need help with a purchase)? Write to ', h('a', { href: 'mailto:team@kody.video' }, 'team@kody.video'), '.')), h('section', { className: 'about-section' }, h('h2', null, 'Version'), h('p', null, h('code', null, shortVersion()), ` · built ${buildDateLabel()}`, ' · ', h('button', {
            type: 'button',
            className: 'link-button',
            disabled: this.updateStatus === 'checking' || this.updateStatus === 'updating',
            onclick: () => this.onCheckForUpdates(),
        }, 'Check for updates')), this.updateStatus !== 'idle'
            ? h('p', { role: 'status', 'aria-live': 'polite' }, UPDATE_STATUS_LABEL[this.updateStatus])
            : null), h('section', { className: 'about-section' }, h('h2', null, 'Legal'), h('p', null, h('a', { href: '/privacy' }, 'Privacy'), ' · ', h('a', { href: '/terms' }, 'Terms'))))));
    }
}
define('kv-about-page', KvAboutPage);
