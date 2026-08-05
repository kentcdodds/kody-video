# Kody Video

Mobile-first web clips camera: **hold anywhere on the preview to record**, arrange clips on a filmstrip timeline, then tap **Go** to export/share — all **on-device**.

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
npm run test:e2e   # Playwright e2e suite (fake camera/mic; recording, editor, playback, export, plans)
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
- Editor: filmstrip timeline (thumbnails, width ∝ duration), drag to reorder, duplicate, delete w/ undo, **in-timeline trim with drag handles**, **add clips from your device/gallery**
- **Background music** (Plus): build a playlist of audio tracks that play one
  after the other under the film at a background-friendly default volume
  (nothing loops — a hint suggests adding another track when the music ends
  before the film does); tap any clip to set the music volume just for that
  clip (duck it under speech, swell it for b-roll), volume changes glide
  across clip boundaries, and the music fades in/out at the start and end of
  the film (both toggleable, on by default) — in the preview and in the
  exported file
- Project preview playback: tap edges to skip clips, tap middle to stop
- Up to **6** stable project slots (create / open / rename / delete, poster art from your clips)
- Big Go CTA: on-device export to **one video file**, then Share (system sheet) or Save
- Fallback: save clips as separate files
- Project **backup/import**: one `.kodyvideo` file per project (clips, trims,
  location data, background music + volumes) — a safety net, and the way to
  move a project between devices or origins (e.g. kody-video.pages.dev →
  kody.video)
- Installable PWA (manifest + Workbox service worker for the app shell)
- **No accounts, no uploads, no analytics**

Most QA is automated: `npm run test:e2e` runs the Playwright suite in
`tests/e2e/` (~40s). See [`manual-test-checklist.md`](./manual-test-checklist.md)
for what it covers and the remaining real-device-only checks.

## Architecture

Built with [Remix 3](https://github.com/remix-run/remix) (`remix@3.0.0-beta.5`,
pinned — v3 is prerelease) as a pure client-side app: `remix/ui` components
rendered with `createRoot`, no server rendering.

```
src/
  lib/storage.ts            IndexedDB (idb) — projects, clip blobs + thumbnails, undo
  lib/project-actions.ts    Loader/mutation helpers for pages
  lib/camera.ts             Camera controller (open/flip/zoom/lens/mic lifecycle)
  lib/recorder.ts           Hold-to-record MediaRecorder wrapper (hardware-codec aware)
  lib/media.ts              getUserMedia/permissions/share/download helpers
  lib/thumbs.ts             Filmstrip thumbnail generation (stored per clip)
  lib/sheet-modal.ts        Bottom-sheet modality (focus trap, Esc, sheet stack)
  lib/export/               Export engines (see below)
  components/record-screen  Camera surface (capture, zoom, timer, dock)
  components/editor-screen  Timeline, trim, clip actions
  pages/                    Home (project slots) + Project (record/editor shell)
  router.tsx                Tiny client router (route-pattern matching + history)
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

1. **Mediabunny + WebCodecs (preferred, all Chromium + recent Firefox/Safari):** each clip's own samples are demuxed and decoded directly by [Mediabunny](https://mediabunny.dev) (no playback pacing — the frame supply runs at hardware speed, keeps working in background tabs, and honors file rotation metadata), composited onto one canvas with the watermark, and encoded/muxed by Mediabunny, which owns the codec-config/packet-ordering/container details. Audio is decoded per clip and appended **sample-accurately**, so audio can never drift across clips; backpressure comes from awaiting the encoder. Container/codec negotiation strongly prefers **MP4 (H.264/HEVC + AAC)** — the most shareable output everywhere — and only falls back to **WebM (VP9/VP8 + Opus)** on non-iOS platforms without MP4 encoders. Clips WebCodecs can't decode take a realtime element-pump fallback per clip.
2. **Realtime fallback:** the old `canvas.captureStream` + `MediaRecorder` stitcher, hardened with timeouts and degenerate-segment skipping, for browsers without WebCodecs.

`plan.ts` is a pure, unit-tested planner that clamps trims and drops unplayable segments up front. The share flow completes the export **first**, then Share/Save run on fresh taps so the Web Share API always has the user activation it requires.

### Recording quality

- Phones prefer **hardware H.264** (`video/mp4`/`h264` MediaRecorder types) over software VP9 — software encoding is what makes previews and clips drop frames on Android.
- Clip duration is measured from the encoded media after stop (wall-clock time includes encoder startup latency and corrupts trim/export math).
- The elapsed timer is a leaf component writing `textContent` from rAF; nothing else re-renders during capture.
- A screen wake lock is held while recording.

### Remix data flow (explicit updates, no hooks)

- **Components** are Remix 3 setup + render functions: state lives in plain
  setup-scope variables, re-renders happen only on explicit `handle.update()`.
- **Pages own their data**: each page loads IndexedDB state in setup and
  exposes `refresh()`; mutations write storage then call `refresh()`.
- **Camera** attaches via the **`ref()` mixin** (start on insert, stop when
  the element's abort signal fires).
- **Blob URLs** bind/revoke in `ref()` mixins (`BlobVideo`, `BlobImage`,
  `TimelineThumbImage`), re-synced from render when the blob changes.
- **Sheets** reset with `key={id}`; modality comes from `lib/sheet-modal.ts`.
- **Timers / toasts** use `requestAnimationFrame` / `setTimeout` started from event handlers.

### Storage (refresh-safe + personal)

| Store    | Contents                                              |
|----------|-------------------------------------------------------|
| projects | JSON metadata + ordered `clipIds`                     |
| clips    | Clip metadata, `Blob` media, filmstrip thumbnails     |
| undo     | Last deleted clip per project (for Undo)              |
| meta     | Settings (`maxProjects`, last opened id, onboarding)  |
| audio    | Background-music playlist per project (blobs, volumes, fades) |

Database name: `kody-video`. Blobs never leave the device unless the user explicitly shares/downloads.

### Offline / PWA

`vite-plugin-pwa` generates a service worker that precaches the app shell (`html/js/css/icons`). After the first successful visit:

1. Airplane mode still loads the SPA from Cache Storage.
2. Project/clip data continues to come from IndexedDB.

Verified approach: `npm run build && npm run preview`, load once online, then DevTools → Network → Offline (or OS airplane mode) and reload.

## Browser limits

- **iOS Safari:** WebCodecs audio support is incomplete; the realtime fallback engine covers it, but Chromium (especially Android) is the primary target.
- **iOS microphone:** WebKit can deliver muted audio tracks when mic and camera come from separate `getUserMedia` calls, so on iOS the mic is acquired together with the camera and held while the preview is open (everywhere else the mic is grabbed per-take). A live level monitor warns "Mic isn't picking up sound" during silent takes on every platform.
- **External mics on iOS (DJI transmitters, AirPods, wired headsets):** iOS pins web capture to the built-in mic by
  default. After the camera opens, the app kicks WebKit's `navigator.audioSession` into
  `play-and-record` — the documented nudge that re-routes capture to a connected external mic —
  and restores the session when the camera closes. Best-effort: routing remains OS-controlled.
- **Permissions:** denied camera/mic must be re-enabled in site settings; the UI surfaces this.
- **Storage quotas:** large projects can hit IndexedDB quotas; the soft 6-project cap helps.
- **Background tabs:** recording should stay in the foreground; browsers may throttle capture.
- **Ultra-wide (0.5×):** Android usually exposes the ultra-wide/telephoto as *separate* rear
  cameras, not as zoom below 1× — the lens chip next to the zoom chips switches between them.
  Some devices don't expose the extra lenses to browsers at all; the chip is hidden there.
  Phones that expose Android's *logical multi-camera* to the browser (zoom range below 1×,
  common on Samsung) get native-style seamless lens hand-off through the zoom gesture instead —
  the app detects such a lens the first time it's opened (cycle the chip once) and locks onto
  it for future sessions. Switching lenses with the chip afterward replaces that memory (your
  explicit choice always wins); opening the seamless lens again re-locks it. iPhones always
  work this way via the OS multi-lens camera.

## Desktop keyboard support

Kody Video is designed as a mobile camera app, but desktop gets first-class
keyboard support (hints appear automatically on fine-pointer devices):

- **Camera:** hold `Space` to record (release to stop), `F` flip, `T`
  self-timer, `S` screen recording, `E` editor, `P` play preview, `Delete`
  remove last clip.
- **Editor:** `←`/`→` select clip, `Alt`+arrows reorder, `T` trim, `D`
  duplicate, `Delete` delete, `P` play, `Esc` back to camera (or exit trim).
- **Playback:** `←`/`→` skip clips, `Space` pause/resume, `Esc` close.

## Screen recording (desktop)

The monitor button on the camera view (or `S`) records a screen, window, or
tab as a regular clip — pick the surface, narrate over your mic (mixed with
shared tab/system audio when you opt in), then tap the preview or the button
to stop and the take lands on the filmstrip like any camera clip. Desktop
browsers only: `getDisplayMedia` does not exist on iOS or Android, so on
phones use the OS screen recorder instead. The button hides itself where the
API is missing.

## Kody Video Plus purchase

The free plan includes one project, and exports carry a small Kody Video mark
in the corner. Kody Video Plus — a one-time $0.99 Stripe Payment Link —
removes the watermark, unlocks six project slots, and unlocks background
music: the export sheet (or a locked home slot, or the locked "Add music"
button in the editor) links to checkout, Stripe redirects back to
`/unlocked?session_id=…`, and a single Cloudflare Pages Function
(`functions/api/verify-purchase.ts`) verifies the session server-side before
the entitlement is stored in IndexedDB. 100%-off promotion codes (friends /
the developer) flow through the exact same verification. Restore on another
device: "Already paid?" on the export sheet or a locked slot's upsell.

Projects are also created lazily — "New project" opens the camera at
`/project/new` and nothing is persisted until the first clip is recorded, so
backing out of an untouched project leaves no empty slot behind.

Deployment requirement: set `STRIPE_SECRET_KEY` (a restricted key with
Checkout Sessions read access is enough) on the Cloudflare Pages project.

## Support

Email [team@kody.video](mailto:team@kody.video) or open a GitHub issue (the
in-app About page has a link that pre-fills device details).

## Privacy

- No accounts, no cookies, no cross-site tracking.
- Page views are counted with [Fathom Analytics](https://usefathom.com)
  (cookieless, anonymous, aggregate-only), loaded only on production
  hostnames.
- No clip upload endpoints exist in this app.
- Share/export uses user-gesture download or the Web Share API only.
- Network calls besides Stripe checkout (opened in the browser): the
  purchase-verification function above (never sees media), and anonymous
  Sentry crash reports (error + stack trace only — breadcrumbs and request
  metadata are stripped in the SDK config; no PII, no media; only from
  production hostnames — dev and tests never report). Export and import
  failures the UI surfaces as friendly messages are also captured, tagged
  with the failing step, so real-device bugs surface.

## Scripts

| Command                              | Purpose                                    |
|--------------------------------------|--------------------------------------------|
| `npm run dev`                        | Vite dev server                            |
| `npm run build`                      | Typecheck + production bundle              |
| `npm run preview`                    | Preview production build                   |
| `npm test`                           | Vitest storage/export-planner tests        |
| `npm run test:e2e`                   | Playwright e2e suite (`tests/e2e/`): recording, editor, playback, export, plans, keyboard |
| `npm run test:smoke`                 | Playwright smoke: record → edit → export   |
| `node scripts/probe-export-chrome.mjs` | Export validation in Chrome stable (real codecs) |
| `node scripts/probe-keyboard.mjs`    | Desktop keyboard flows (record/edit/playback) |
| `node scripts/probe-rear-lens.mjs`   | Rear lens switching (ultra-wide) with fake cameras |
| `node scripts/probe-fast-export.mjs` | Decode-driven export beats realtime (MP4 clips) |
| `node scripts/probe-mic-monitor.mjs`  | Silent-mic warning fires (and clears) correctly |
| `node scripts/probe-screen-record.mjs` | Desktop screen recording lands as a clip |
| `node scripts/probe-touch-timeline.mjs` | Touch timeline gestures (scroll, long-press lift) |
| `node scripts/probe-webkit.mjs`      | WebKit engine sanity + feature matrix (iOS proxy, not a substitute for a real device) |

## License

Kody Video is licensed under the
[Functional Source License, Version 1.1, ALv2 Future License](./LICENSE)
([FSL-1.1-ALv2](https://fsl.software/)). You can use, copy, modify, create
derivative works from, publicly perform, publicly display, and redistribute the
software for any purpose other than Competing Use. Competing Use means making
the software available to others in a commercial product or service that
substitutes for Kody Video, substitutes for another product or service the
licensor offers using Kody Video that existed when the version was made
available, or offers the same or substantially similar functionality. Each
version becomes available under the Apache License 2.0 on the second anniversary
of the date that version was made available.
