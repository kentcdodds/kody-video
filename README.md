# Kody Video — TypeScript edition

Mobile-first web clips camera: **hold anywhere on the preview to record**, arrange clips on a filmstrip timeline, then tap **Go** to export/share — all **on-device**.

This branch is the third edition in an experiment series: the same app as the [vanilla edition](https://github.com/kentcdodds/kody-video/tree/vanilla) (web components, no framework, no bundler, no runtime dependencies except Mediabunny), but **authored in strict TypeScript** with `tsc` as the only build step.

- **No framework** — the UI is hand-written [web components](src/app/components/) (custom elements, plain DOM).
- **`tsc` is the entire build** — `erasableSyntaxOnly` + `rewriteRelativeImportExtensions` mean the TypeScript in `src/` erases 1:1 to the JavaScript the browser runs. No bundler, no minifier, no hashing; the emitted files in `public/js/` are committed so a checkout is deployable as-is.
- **No runtime dependencies** — except [Mediabunny](https://mediabunny.dev) (vendored at `public/vendor/mediabunny.min.mjs`, resolved via an import map; the npm package is a dev-dependency for its types only). Everything else is hand-rolled: a [typed IndexedDB promise wrapper](src/app/lib/idb.ts) (replaces `idb`, keeps its `DBSchema` generics), a [streaming ZIP writer](src/app/lib/zip.ts) (replaces `client-zip`), a [hand-written service worker](src/service-worker/sw.ts) (replaces Workbox), console-only [error reporting](src/app/lib/error-reporting.ts) (replaces Sentry). No analytics.
- **Vanilla Cloudflare** — a single [Worker](src/worker/worker.ts) serves the static assets and the one API route (Stripe purchase verification). Configured in [`wrangler.jsonc`](wrangler.jsonc).

Kody Video is inspired by the OK Video interaction model: camera-first capture, quick clip cleanup, and one big Go/share moment. It is an independent project with its own name, mark, and implementation; it is not affiliated with OK Video and does not use OK Video trademarks or assets. The koala mascot is credited to the KCD community / [kentcdodds.com/kody](https://kentcdodds.com/kody).

## Quick start

```bash
npm install        # typescript + mediabunny types (dev-only)
npm run build      # tsc → public/js, public/sw.js, dist-worker/worker.js
npx wrangler dev   # serve with the /api route
```

Because the emitted JavaScript is committed, you can also skip the toolchain entirely and serve `public/` with any static file server. Camera/microphone require a **secure context** (`http://localhost` or HTTPS).

**Live experiment:** [https://typescript.kody.video](https://typescript.kody.video) (temporary worker). Siblings: [vanilla.kody.video](https://vanilla.kody.video) (same app, plain JS) and [kody.video](https://kody.video) (the Remix 3 production app).

## Deploying

```bash
npm run deploy     # tsc build + wrangler deploy
```

Purchase verification needs the `STRIPE_SECRET_KEY` secret (`npx wrangler secret put STRIPE_SECRET_KEY`); without it the endpoint degrades gracefully. When shipping changes, bump `CACHE_VERSION` in [`src/service-worker/sw.ts`](src/service-worker/sw.ts) (and `APP_VERSION` in [`src/app/lib/build-info.ts`](src/app/lib/build-info.ts)) — the version string is the offline-cache buster.

## What works

Feature-for-feature the same app as the other editions:

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
src/
  app/                     TypeScript sources (strict; erasable syntax only)
    dom.ts                 ~140-line DOM helper + generic KvElement<Props> base
    router.ts              pushState router (link intercepts, popstate)
    app.ts                 <kv-app>: route outlet + SW update toast
    main.ts                Entry point
    lib/                   App logic — the ORIGINAL TypeScript sources from
                           the Remix edition, imports aside (storage, camera,
                           recorder, media, thumbs, export engines, …)
      idb.ts               Typed IndexedDB wrapper (DBSchema generics kept)
      zip.ts               Streaming store-mode ZIP writer
    components/            Web components (custom elements, no shadow DOM)
    pages/                 <kv-home-page>, <kv-project-page>, about/legal
  service-worker/sw.ts     → public/sw.js
  worker/worker.ts         → dist-worker/worker.js (Cloudflare Worker)
public/
  index.html               App shell + import map (mediabunny)
  js/                      tsc output (committed — deployable without tools)
  styles/                  Plain CSS (unchanged across all three editions)
  vendor/mediabunny.min.mjs
tsconfig.app.json          Browser app project
tsconfig.sw.json           Service-worker project (WebWorker lib)
tsconfig.worker.json       Cloudflare Worker project
```

### How the UI works without a framework

Identical to the vanilla edition, now with types:

- Components are custom elements extending a generic `KvElement<Props>` base: `props` assigned by the parent (fully typed per component), an `AbortController` per mount, blob-URL bookkeeping, and a `render()`/`update()` pair.
- Screens that host live media (camera preview, playback video) build their DOM **once** and sync state imperatively — nothing re-renders per frame while recording.
- Simple views (home, sheets, static pages) rebuild their DOM on state change.
- The timeline keeps tile elements stable during drags so pointer capture survives, and only rebuilds when clip data actually changes.

### Storage, export, quality

The device-facing logic (camera lens handling, iOS audio-session quirks, recording codec preferences, the two-engine export pipeline, chapters/geotags, OPFS-backed export cache) is the original TypeScript from the Remix edition, byte-for-byte except import paths and the dependency seams. Database name and schema are unchanged (`kody-video`), so projects created by any edition on the same origin are compatible.

## Support

Email [team@kody.video](mailto:team@kody.video) or open a GitHub issue (the in-app About page has a link that pre-fills device details).

## Privacy

- No accounts, no cookies, no tracking, no analytics, no crash reporting.
- No clip upload endpoints exist in this app.
- Share/export uses user-gesture download or the Web Share API only.
- The only network call besides Stripe checkout (opened in the browser) is the purchase-verification endpoint above (never sees media).
