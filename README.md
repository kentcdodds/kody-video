# Kody Video — vanilla edition

Mobile-first web clips camera: **hold anywhere on the preview to record**, arrange clips on a filmstrip timeline, then tap **Go** to export/share — all **on-device**.

This branch is an experiment: the whole app re-implemented with **only web-standard technology**.

- **No framework** — the UI is hand-written [web components](public/js/components/) (custom elements, plain DOM).
- **No build step** — the browser loads the ES modules in `public/js/` directly; an [import map](public/index.html) resolves the one bare specifier.
- **No dependencies** — except [Mediabunny](https://mediabunny.dev) (vendored at `public/vendor/mediabunny.min.mjs`), which powers the on-device export pipeline. Everything else that used to be an npm package is hand-rolled vanilla code: a [minimal IndexedDB promise wrapper](public/js/lib/idb.js) (replaces `idb`), a [streaming ZIP writer](public/js/lib/zip.js) (replaces `client-zip`), a [hand-written service worker](public/sw.js) (replaces Workbox/`vite-plugin-pwa`), and console-only [error reporting](public/js/lib/error-reporting.js) (replaces Sentry). No analytics.
- **Vanilla Cloudflare** — a single [Worker](worker.js) serves the static assets and the one API route (Stripe purchase verification). Configured in [`wrangler.jsonc`](wrangler.jsonc).

Kody Video is inspired by the OK Video interaction model: camera-first capture, quick clip cleanup, and one big Go/share moment. It is an independent project with its own name, mark, and implementation; it is not affiliated with OK Video and does not use OK Video trademarks or assets. The koala mascot is credited to the KCD community / [kentcdodds.com/kody](https://kentcdodds.com/kody).

## Quick start

There is nothing to install and nothing to build. Serve the `public/` directory over HTTP and open it in Chrome:

```bash
npx wrangler dev        # full setup: static assets + the /api route
# or any static file server:
python3 -m http.server -d public 8000
```

Camera/microphone require a **secure context** (`http://localhost` or HTTPS).

**Live experiment:** [https://vanilla.kody.video](https://vanilla.kody.video) (temporary worker). The original app lives at [kody.video](https://kody.video).

## Deploying

```bash
npx wrangler deploy
```

That's it — no build. `wrangler.jsonc` points the worker at `worker.js` and the assets at `public/`, with SPA fallback for client-side routes and `run_worker_first` for `/api/*`. Purchase verification needs the `STRIPE_SECRET_KEY` secret (`npx wrangler secret put STRIPE_SECRET_KEY`); without it the endpoint degrades gracefully (the UI shows "verification is not configured").

When shipping changes, bump `CACHE_VERSION` in [`public/sw.js`](public/sw.js) (and `APP_VERSION` in [`public/js/lib/build-info.js`](public/js/lib/build-info.js)) — the version string is the offline-cache buster; there is no build-hash pipeline.

## What works

Feature-for-feature the same app as the framework edition:

- Full-bleed live camera (rear preferred; flip, torch, and zoom when the device exposes them)
- Hold-to-record anywhere on the preview; drag up/down while holding to zoom
- Self-timer, desktop screen recording, silent-mic warning, optional location tagging
- Editor: filmstrip timeline (thumbnails, width ∝ duration), drag to reorder, duplicate, delete w/ undo, in-timeline trim with drag handles
- Project preview playback: tap edges to skip clips, tap middle to stop
- Up to **6** stable project slots (create / open / rename / delete, poster art from your clips)
- Big Go CTA: on-device export to **one video file** (Mediabunny + WebCodecs, realtime `MediaRecorder` fallback), then Share or Save
- MP4 chapter markers per clip + optional geotag; cached last export (OPFS) for instant re-share
- Project backup/import (`.kodyvideo` files), save-clips-as-zip fallback
- Installable PWA with an offline app shell and prompt-based updates
- Desktop keyboard support throughout
- **No accounts, no uploads, no analytics**

## Architecture

```
worker.js                  Cloudflare Worker: assets + /api/verify-purchase
wrangler.jsonc             Worker config (SPA fallback, custom domain)
public/
  index.html               App shell + import map (mediabunny)
  sw.js                    Hand-written service worker (precache, updates)
  manifest.webmanifest     PWA manifest
  styles/                  Plain CSS (global, home, record, editor)
  vendor/mediabunny.min.mjs  The one dependency, vendored
  js/
    dom.js                 ~100-line DOM helper + KvElement base class
    router.js              pushState router (link intercepts, popstate)
    app.js                 <kv-app>: route outlet + SW update toast
    main.js                Entry point
    lib/                   Ported app logic (framework-free already):
      storage.js             IndexedDB — projects, clip blobs, thumbs, undo
      idb.js                 Minimal promise wrapper over raw IndexedDB
      camera.js              Camera controller (open/flip/zoom/lens/mic)
      recorder.js            Hold-to-record MediaRecorder wrapper
      media.js               getUserMedia/permissions/share/download
      thumbs.js              Filmstrip thumbnail generation
      zip.js                 Streaming store-mode ZIP writer
      export/                Export engines (Mediabunny+WebCodecs, realtime)
      …
    components/            Web components (custom elements, no shadow DOM)
      record-screen.js       <kv-record-screen> — capture, zoom, timer, dock
      editor-screen.js       <kv-editor-screen> — timeline, trim, actions
      timeline.js            <kv-timeline> — tiles, reorder, fling scrolling
      playback-overlay.js    <kv-playback-overlay> — sequential preview
      …
    pages/                 <kv-home-page>, <kv-project-page>, about/legal
```

### How the UI works without a framework

- Components are custom elements extending a ~60-line `KvElement` base: `props` assigned by the parent, an `AbortController` per mount, blob-URL bookkeeping, and a `render()`/`update()` pair.
- Screens that host live media (camera preview, playback video) build their DOM **once** and sync state imperatively — classes, `hidden`, `textContent`. Nothing re-renders per frame while recording; the elapsed timer writes `textContent` from `requestAnimationFrame`.
- Simple views (home, sheets, static pages) just rebuild their DOM on state change.
- The timeline keeps tile elements stable during drags so pointer capture survives, and only rebuilds when clip data actually changes.

### Storage, export, quality

The device-facing logic (camera lens handling, iOS audio-session quirks, recording codec preferences, the two-engine export pipeline, chapters/geotags, OPFS-backed export cache) is ported line-for-line from the framework edition — see that README (`git show main:README.md`) for the full write-ups. Database name and schema are unchanged (`kody-video`), so projects created by either edition on the same origin are compatible.

## Support

Email [team@kody.video](mailto:team@kody.video) or open a GitHub issue (the in-app About page has a link that pre-fills device details).

## Privacy

- No accounts, no cookies, no tracking, no analytics, no crash reporting.
- No clip upload endpoints exist in this app.
- Share/export uses user-gesture download or the Web Share API only.
- The only network call besides Stripe checkout (opened in the browser) is the purchase-verification endpoint above (never sees media).
