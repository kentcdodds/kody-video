/**
 * Hand-written service worker (no Workbox): precaches the app shell so the
 * SPA loads offline after the first visit, serves navigations from the
 * cached index.html, and takes over on SKIP_WAITING so the update toast
 * actually applies.
 *
 * Bump CACHE_VERSION whenever any precached file changes — there is no
 * build-hash pipeline; the version string IS the cache buster. Keep it in
 * sync with APP_VERSION in src/app/lib/build-info.ts.
 */

/** Typed handle on the service-worker global (the file stays a classic
 * script, so no module-scope `declare const self` — that would force an
 * `export {}` into the emitted JS). */
const sw = self as unknown as ServiceWorkerGlobalScope

const CACHE_VERSION = 'typescript-1'
const CACHE_NAME = `kody-video-${CACHE_VERSION}`

// The app shell. `og-image.png` and `art/kody-video-icon.png` are excluded
// on purpose: the social card is for link scrapers and the icon master is
// only a source file — neither belongs in every visitor's cache.
// Note: the app shell is cached as '/' — the assets server redirects
// '/index.html' to '/', and a redirected cached response is rejected by
// Chromium when used for a navigation (net::ERR_FAILED).
const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/styles/global.css',
  '/styles/home.css',
  '/styles/record.css',
  '/styles/editor.css',
  '/vendor/mediabunny.min.mjs',
  '/js/main.js',
  '/js/app.js',
  '/js/dom.js',
  '/js/router.js',
  '/js/components/brand-mark.js',
  '/js/components/clip-preview.js',
  '/js/components/editor-screen.js',
  '/js/components/export-overlay.js',
  '/js/components/export-sheet.js',
  '/js/components/icons.js',
  '/js/components/onboarding-overlay.js',
  '/js/components/playback-overlay.js',
  '/js/components/record-screen.js',
  '/js/components/sheet-shell.js',
  '/js/components/sheets.js',
  '/js/components/timeline.js',
  '/js/components/trim-strip.js',
  '/js/lib/app-update.js',
  '/js/lib/audio-session.js',
  '/js/lib/build-info.js',
  '/js/lib/camera.js',
  '/js/lib/clips-zip.js',
  '/js/lib/drag-zoom.js',
  '/js/lib/entitlement.js',
  '/js/lib/error-reporting.js',
  '/js/lib/export/encode-realtime.js',
  '/js/lib/export/encode-webcodecs.js',
  '/js/lib/export/export-cache.js',
  '/js/lib/export/index.js',
  '/js/lib/export/last-export.js',
  '/js/lib/export/media-error.js',
  '/js/lib/export/mp4-metadata.js',
  '/js/lib/export/opfs.js',
  '/js/lib/export/plan.js',
  '/js/lib/export/shared.js',
  '/js/lib/geo.js',
  '/js/lib/idb.js',
  '/js/lib/install-hint.js',
  '/js/lib/install-prompt.js',
  '/js/lib/keyboard.js',
  '/js/lib/location.js',
  '/js/lib/media.js',
  '/js/lib/mic-monitor.js',
  '/js/lib/project-actions.js',
  '/js/lib/project-transfer.js',
  '/js/lib/recorder.js',
  '/js/lib/screen-recorder.js',
  '/js/lib/sheet-modal.js',
  '/js/lib/storage.js',
  '/js/lib/storage-space.js',
  '/js/lib/thumbs.js',
  '/js/lib/types.js',
  '/js/lib/zip.js',
  '/js/lib/zoom-chips.js',
  '/js/pages/about-page.js',
  '/js/pages/home-page.js',
  '/js/pages/legal-pages.js',
  '/js/pages/project-page.js',
  '/js/pages/unlocked-page.js',
  '/favicon.png',
  '/apple-touch-icon.png',
  '/pwa-192.png',
  '/pwa-512.png',
  '/pwa-512-maskable.png',
  '/kody-mark.webp',
  '/kody-profile.png',
  '/art/kody-app-icon.webp',
  '/art/kody-holding-camera.webp',
  '/art/kody-thumbs-up-share.webp',
  '/art/kody-timeline-peek.webp',
]

sw.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      // Bypass the HTTP cache so a version bump really fetches new files.
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })))),
  )
})

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)),
      )
      // Without clients.claim() the updated worker activates after
      // SKIP_WAITING but never takes over the open client —
      // `controllerchange` never fires and the update button looks dead.
      await sw.clients.claim()
    })(),
  )
})

sw.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    void sw.skipWaiting()
  }
})

sw.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== sw.location.origin) return
  // Never SPA-fallback these: the API must always hit the server, and the
  // social card must open as the image it is.
  if (url.pathname.startsWith('/api/')) return
  if (url.pathname === '/og-image.png') return

  // Navigations get the cached app shell (offline-first SPA).
  if (request.mode === 'navigate') {
    event.respondWith(caches.match('/').then((cached) => cached ?? fetch(request)))
    return
  }

  // Static assets: cache-first, falling back to the network.
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => cached ?? fetch(request)),
  )
})
