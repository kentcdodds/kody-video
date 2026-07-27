# Kody Video

Mobile-first web clips camera: **hold anywhere on the preview to record**, arrange clips on a filmstrip timeline, then tap **OK** to export/share — all **on-device**.

Kody Video is inspired by the OK Video interaction model: camera-first capture, quick clip cleanup, and one big OK/share moment. It is an independent project with its own name, mark, and implementation; it is not affiliated with OK Video and does not use OK Video trademarks or assets. The koala mascot is credited to the KCD community / [kentcdodds.com/kody](https://kentcdodds.com/kody). App artwork in `public/art/` was generated from that Kody reference (camera, timeline, share, app icon).

## Quick start

```bash
npm install
npm run dev
```

Open the printed localhost URL in Chrome (desktop or Android). Camera/microphone require a **secure context** (`http://localhost` or HTTPS).

```bash
npm run build      # production build + service worker
npm run preview    # serve dist (PWA cache active)
npm test           # storage/export-planner unit tests
npm run test:smoke # Playwright UX smoke (fake camera, records + exports)
```

**Live app:** [https://kody.video](https://kody.video) (Cloudflare Pages, builds from `main`; the original
[kody-video.pages.dev](https://kody-video.pages.dev) origin stays live so existing on-device projects remain accessible)

For a phone on the same network, use your machine’s LAN URL over HTTPS, or tunnel (`npm run dev -- --host` plus a trusted tunnel). `getUserMedia` will fail on plain `http://<lan-ip>` in most browsers.

## What works

- Full-bleed live camera (rear preferred; flip, torch, and zoom when the device exposes them)
- Hold-to-record anywhere on the preview; drag up/down while holding to zoom
- Self-timer for hands-free takes (tap to stop)
- Recording feedback (REC pill + elapsed) with a page that does **not** re-render per frame — capture stays smooth
- Editor: filmstrip timeline (thumbnails, width ∝ duration), drag to reorder, duplicate, delete w/ undo, **in-timeline trim with drag handles**
- Project preview playback: tap edges to skip clips, tap middle to stop
- Up to **6** stable project slots (create / open / rename / delete, poster art from your clips)
- Big OK CTA: on-device export to **one video file**, then Share (system sheet) or Save
- Fallback: save clips as separate files
- Installable PWA (manifest + Workbox service worker for the app shell)
- **No accounts, no uploads, no analytics**

See [`manual-test-checklist.md`](./manual-test-checklist.md) for camera/offline QA steps.

## Architecture

```
src/
  lib/storage.ts            IndexedDB (idb) — projects, clip blobs + thumbnails, undo
  lib/project-actions.ts    Loader/mutation helpers for routes
  lib/recorder.ts           Hold-to-record MediaRecorder wrapper (hardware-codec aware)
  lib/media.ts              getUserMedia/permissions/share/download helpers
  lib/thumbs.ts             Filmstrip thumbnail generation (stored per clip)
  lib/export/               Export engines (see below)
  components/record-screen  Camera surface (capture, zoom, timer, dock)
  components/editor-screen  Timeline, trim, clip actions
  pages/                    Home (project slots) + Project (record/editor shell)
  router.tsx                React Router data routers (loaders)
```

### Chapters & optional location

MP4 exports carry **chapter markers** at every clip boundary (Nero `chpl`,
injected post-mux by `lib/export/mp4-metadata.ts`), titled with each clip's
recording time. With the opt-in **location tagging** toggle on the record
screen, clips store device coordinates (kept in IndexedDB alongside the clip,
never inside the MediaRecorder blob), chapter titles include them, and the
file gets a `©xyz` geotag — derived by averaging the majority cluster of clip
locations (within 5 km), falling back to the first located clip. WebM exports
skip both (the WebM subset of Matroska excludes chapters). Clips recorded
before this feature simply lack the data and degrade gracefully.

### Export pipeline

`lib/export/` stitches clips into one file with two engines:

1. **WebCodecs (preferred, all Chromium + recent Firefox/Safari):** each clip plays muted while frames are captured via `requestVideoFrameCallback`, normalized on a canvas, and encoded with `VideoEncoder`. Audio is decoded (`decodeAudioData`) and encoded **sample-accurately** per segment, so audio can never drift across clips. Encoder backpressure pauses the source, so slow devices slow the export down instead of dropping frames. Container/codec negotiation prefers **MP4 (H.264 + AAC)** — the most shareable output on Android — and falls back to **WebM (VP9/VP8 + Opus)**.
2. **Realtime fallback:** the old `canvas.captureStream` + `MediaRecorder` stitcher, hardened with timeouts and degenerate-segment skipping, for browsers without WebCodecs.

`plan.ts` is a pure, unit-tested planner that clamps trims and drops unplayable segments up front. The share flow completes the export **first**, then Share/Save run on fresh taps so the Web Share API always has the user activation it requires.

### Recording quality

- Phones prefer **hardware H.264** (`video/mp4`/`h264` MediaRecorder types) over software VP9 — software encoding is what makes previews and clips drop frames on Android.
- Clip duration is measured from the encoded media after stop (wall-clock time includes encoder startup latency and corrupts trim/export math).
- The elapsed timer is a leaf component writing `textContent` from rAF; nothing else re-renders during capture.
- A screen wake lock is held while recording.

### React data flow (no `useEffect` for app logic)

- **Route loaders** (`homeLoader` / `projectLoader`) load IndexedDB state; mutations call `useRevalidator()`.
- **Camera** attaches via a **video ref callback** (start on mount, stop on unmount).
- **Blob URLs** bind/revoke in media ref callbacks (`BlobVideo`, `BlobImage`, `TimelineThumbImage`).
- **Sheets** reset with `key={id}` instead of syncing props → state in an effect.
- **Timers / toasts** use `requestAnimationFrame` / `setTimeout` started from event handlers.

### Storage (refresh-safe + personal)

| Store    | Contents                                              |
|----------|-------------------------------------------------------|
| projects | JSON metadata + ordered `clipIds`                     |
| clips    | Clip metadata, `Blob` media, filmstrip thumbnails     |
| undo     | Last deleted clip per project (for Undo)              |
| meta     | Settings (`maxProjects`, last opened id, onboarding)  |

Database name: `kody-video`. Blobs never leave the device unless the user explicitly shares/downloads.

### Offline / PWA

`vite-plugin-pwa` generates a service worker that precaches the app shell (`html/js/css/icons`). After the first successful visit:

1. Airplane mode still loads the SPA from Cache Storage.
2. Project/clip data continues to come from IndexedDB.

Verified approach: `npm run build && npm run preview`, load once online, then DevTools → Network → Offline (or OS airplane mode) and reload.

## Browser limits

- **iOS Safari:** WebCodecs audio support is incomplete; the realtime fallback engine covers it, but Chromium (especially Android) is the primary target.
- **Permissions:** denied camera/mic must be re-enabled in site settings; the UI surfaces this.
- **Storage quotas:** large projects can hit IndexedDB quotas; the soft 6-project cap helps.
- **Background tabs:** recording should stay in the foreground; browsers may throttle capture.

## Remove Watermark purchase

Exports carry a small Kody Video mark in the corner. A one-time $0.99 Stripe
Payment Link removes it: the export sheet links to checkout, Stripe redirects
back to `/unlocked?session_id=…`, and a single Cloudflare Pages Function
(`functions/api/verify-purchase.ts`) verifies the session server-side before
the entitlement is stored in IndexedDB. 100%-off promotion codes (friends /
the developer) flow through the exact same verification. Restore on another
device: paste the Stripe receipt link into "Already paid?" on the export
sheet.

Deployment requirement: set `STRIPE_SECRET_KEY` (a restricted key with
Checkout Sessions read access is enough) on the Cloudflare Pages project.

## Privacy

- No telemetry, analytics, or accounts.
- No clip upload endpoints exist in this app.
- Share/export uses user-gesture download or the Web Share API only.
- The only network call besides Stripe checkout (opened in the browser) is
  the purchase-verification function above; it never sees media.

## Scripts

| Command                              | Purpose                                    |
|--------------------------------------|--------------------------------------------|
| `npm run dev`                        | Vite dev server                            |
| `npm run build`                      | Typecheck + production bundle              |
| `npm run preview`                    | Preview production build                   |
| `npm test`                           | Vitest storage/export-planner tests        |
| `npm run test:smoke`                 | Playwright smoke: record → edit → export   |
| `node scripts/probe-export-chrome.mjs` | Export validation in Chrome stable (real codecs) |
