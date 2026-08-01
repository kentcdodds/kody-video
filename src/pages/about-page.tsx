import { useState } from 'react'
import { Link, useLoaderData, useRevalidator } from 'react-router-dom'
import { IconBack } from '../components/icons'
import { BrandMark } from '../components/brand-mark'
import { checkForUpdates } from '../lib/app-update'
import { buildDateLabel, shortVersion } from '../lib/build-info'
import { clearExportCache, estimateExportCacheBytes } from '../lib/export/export-cache'
import { estimateStorageSpace, formatBytes, type StorageSpace } from '../lib/storage-space'

/** Prefilled GitHub issue so bug reports arrive with device context attached. */
function reportProblemUrl(): string {
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
  ].join('\n')
  const params = new URLSearchParams({ labels: 'bug', body })
  return `https://github.com/kentcdodds/kody-video/issues/new?${params}`
}

export interface AboutLoaderData {
  storage: StorageSpace | null
  exportCacheBytes: number
}

export async function aboutLoader(): Promise<AboutLoaderData> {
  const [storage, exportCacheBytes] = await Promise.all([
    estimateStorageSpace(),
    estimateExportCacheBytes(),
  ])
  return { storage, exportCacheBytes }
}

type UpdateStatus = 'idle' | 'checking' | 'current' | 'updating' | 'downloading' | 'unavailable'

const UPDATE_STATUS_LABEL: Record<Exclude<UpdateStatus, 'idle'>, string> = {
  checking: 'Checking…',
  current: "You're on the latest version.",
  updating: 'Update found — reloading…',
  downloading: 'Update found — still downloading. It will offer itself when ready.',
  unavailable: "Couldn't check right now (offline, or not running from a deployment).",
}

/** Credits, inspiration, and the open-source pointer. */
export function AboutPage() {
  const { storage, exportCacheBytes } = useLoaderData() as AboutLoaderData
  const revalidator = useRevalidator()
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle')
  const [cacheStatus, setCacheStatus] = useState<string | null>(null)
  const [clearingCache, setClearingCache] = useState(false)

  const onClearExportCache = () => {
    if (clearingCache) return
    setClearingCache(true)
    void clearExportCache()
      .then((freedBytes) => {
        setCacheStatus(`Freed ${formatBytes(freedBytes)}.`)
        void revalidator.revalidate()
      })
      .catch(() => setCacheStatus('Could not clear cached exports — try again.'))
      .finally(() => setClearingCache(false))
  }

  const onCheckForUpdates = () => {
    if (updateStatus === 'checking' || updateStatus === 'updating') return
    setUpdateStatus('checking')
    void checkForUpdates()
      .then((result) => {
        switch (result) {
          case 'updated':
            // checkForUpdates already applied it; the page is about to reload.
            setUpdateStatus('updating')
            return
          case 'current':
            setUpdateStatus('current')
            return
          case 'downloading':
            setUpdateStatus('downloading')
            return
          case 'unavailable':
            setUpdateStatus('unavailable')
            return
          default: {
            const exhaustive: never = result
            throw new Error(`Unhandled update result: ${String(exhaustive)}`)
          }
        }
      })
      .catch(() => setUpdateStatus('unavailable'))
  }

  return (
    <div className="screen about-screen">
      <div className="about-top">
        <Link to="/" className="btn-icon" aria-label="Back to projects">
          <IconBack />
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
            No accounts, no uploads, no cross-site tracking. Clips live in this browser&rsquo;s
            storage until you export and share them yourself. The app&rsquo;s only own network
            traffic: Stripe checkout and its purchase verification if you buy the watermark
            removal, anonymous crash reports (error and stack trace only — never your media) when
            something breaks, and cookieless page-view counts via Fathom Analytics.
          </p>
        </section>

        <section className="about-section">
          <h2>Made for phones</h2>
          <p>
            Kody Video is designed as a mobile camera app — install it on your phone for the real
            experience. It works on desktop too, with keyboard support: hold <kbd>Space</kbd> to
            record, <kbd>F</kbd> flips the camera, <kbd>T</kbd> starts the self-timer,{' '}
            <kbd>E</kbd> opens the editor, <kbd>P</kbd> plays your cut, and <kbd>Delete</kbd>{' '}
            removes the last clip. In the editor the arrow keys select clips,{' '}
            <kbd>Alt</kbd>+arrows reorder, <kbd>T</kbd> trims, <kbd>D</kbd> duplicates,{' '}
            <kbd>Delete</kbd> deletes, and <kbd>Esc</kbd> goes back. During playback the arrows
            skip clips, <kbd>Space</kbd> pauses, and <kbd>Esc</kbd> closes.
          </p>
        </section>

        <section className="about-section">
          <h2>Storage</h2>
          <p>
            {storage
              ? `This app uses ${formatBytes(storage.usedBytes)} of the ${formatBytes(storage.quotaBytes)} the browser allows. `
              : ''}
            Your recordings are the big consumer — delete old projects from the home screen
            (⋯ → Delete) to free the most space. The app also keeps your latest export cached so
            tapping Go on an unchanged project is instant.
          </p>
          <p>
            Cached export files: <strong>{formatBytes(exportCacheBytes)}</strong>
            {exportCacheBytes > 0 ? (
              <>
                {' · '}
                <button
                  type="button"
                  className="link-button"
                  onClick={onClearExportCache}
                  disabled={clearingCache}
                >
                  Clear
                </button>
              </>
            ) : null}
          </p>
          {cacheStatus ? (
            <p role="status" aria-live="polite">
              {cacheStatus}
            </p>
          ) : null}
        </section>

        <section className="about-section">
          <h2>Support</h2>
          <p>
            Hit a bug? Please{' '}
            <a href={reportProblemUrl()} target="_blank" rel="noreferrer noopener">
              open an issue on GitHub
            </a>{' '}
            — the link pre-fills your device details so you only have to describe what went wrong.
            Prefer email (or need help with a purchase)? Write to{' '}
            <a href="mailto:team@kody.video">team@kody.video</a>.
          </p>
        </section>

        <section className="about-section">
          <h2>Version</h2>
          <p>
            <code>{shortVersion()}</code> · built {buildDateLabel()}
            {' · '}
            <button
              type="button"
              className="link-button"
              onClick={onCheckForUpdates}
              disabled={updateStatus === 'checking' || updateStatus === 'updating'}
            >
              Check for updates
            </button>
          </p>
          {updateStatus !== 'idle' ? (
            <p role="status" aria-live="polite">
              {UPDATE_STATUS_LABEL[updateStatus]}
            </p>
          ) : null}
        </section>

        <section className="about-section">
          <h2>Legal</h2>
          <p>
            <Link to="/privacy">Privacy</Link>
            {' · '}
            <Link to="/terms">Terms</Link>
          </p>
        </section>
      </div>
    </div>
  )
}
