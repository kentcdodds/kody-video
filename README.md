# Go Video Go (GVG)

Mobile-first web clips camera: **hold anywhere on the preview to record**, arrange clips on a timeline, then export/share — all **on-device**.

Inspired by the “tap-and-hold highlights” idea popularized by apps like OK Video — **Go Video Go is an independent project** with its own name, mark, and implementation. Not affiliated; no proprietary assets or trademarks are used.

## Quick start

```bash
npm install
npm run dev
```

Open the printed localhost URL in Chrome (desktop or Android). Camera/microphone require a **secure context** (`http://localhost` or HTTPS).

```bash
npm run build    # production build + service worker
npm run preview  # serve dist (PWA cache active)
npm test         # IndexedDB/storage unit tests
```

For a phone on the same network, use your machine’s LAN URL over HTTPS, or tunnel (`npm run dev -- --host` plus a trusted tunnel). `getUserMedia` will fail on plain `http://<lan-ip>` in most browsers.

## What works (v1)

- Live camera preview (rear preferred; flip when multiple cameras exist)
- Hold-to-record anywhere on the preview via `MediaRecorder` + pointer events
- Recording feedback (red pulse + elapsed) and project total duration
- Timeline: select, delete, undo delete, reorder (left/right), duplicate, trim in/out
- Sequential project preview playback
- Up to **6** local projects (create / open / rename / delete)
- Export: stitch clips to a single WebM (canvas `captureStream` + `MediaRecorder`), then Web Share API or download
- Fallback: download clips as separate files
- Installable PWA (manifest + Workbox service worker for app shell)
- **No accounts, no uploads, no analytics**

See [`manual-test-checklist.md`](./manual-test-checklist.md) for camera/offline QA steps.

## Architecture

```
src/
  lib/storage.ts          IndexedDB (idb) — projects, clip blobs, undo snapshot
  lib/project-actions.ts  Loader/mutation helpers for routes
  lib/recorder.ts         Hold-to-record MediaRecorder wrapper
  lib/media.ts            getUserMedia helpers + canvas export stitching
  pages/                  Home (project list) + Project (camera/editor)
  router.tsx              React Router data routers (loaders)
```

### React data flow (no `useEffect` for app logic)

- **Route loaders** (`homeLoader` / `projectLoader`) load IndexedDB state; mutations call `useRevalidator()`.
- **Camera** attaches via a **video ref callback** (start on mount, stop on unmount) — no mount effect.
- **Blob URLs** bind/revoke in media ref callbacks (`BlobVideo`).
- **Sheets** reset with `key={id}` instead of syncing props → state in an effect.
- **Recording timer / toasts** use `requestAnimationFrame` / `setTimeout` started from event handlers.

### Storage (refresh-safe + personal)

| Store    | Contents                                      |
|----------|-----------------------------------------------|
| projects | JSON metadata + ordered `clipIds`             |
| clips    | Clip metadata **and** `Blob` media            |
| undo     | Last deleted clip per project (for Undo)      |
| meta     | Settings (`maxProjects`, last opened id)      |

Database name: `go-video-go`. Blobs never leave the device unless the user explicitly shares/downloads.

### Offline / PWA

`vite-plugin-pwa` generates a service worker that precaches the app shell (`html/js/css/icons`). After the first successful visit:

1. Airplane mode still loads the SPA from Cache Storage.
2. Project/clip data continues to come from IndexedDB.

Verified approach: `npm run build && npm run preview`, load once online, then DevTools → Network → Offline (or OS airplane mode) and reload.

### Export tradeoffs

**Preferred path:** sequential playback of each clip (honoring trim) into a canvas, `captureStream(30)`, mix audio via `AudioContext`, record with `MediaRecorder` → one `.webm`.

| Pros | Cons |
|------|------|
| Single file, no server, no huge wasm download | Re-encodes; quality/bitrate vary by browser |
| Works in Chromium without ffmpeg.wasm | Some browsers are flaky with audio capture from media elements |
| Trim in/out applied during export | Portrait 720×1280 canvas may letterbox/crop sources |

If stitching fails, use **Files** in the share sheet to download each original recording locally.

## Browser limits

- **iOS Safari:** `MediaRecorder` / canvas export support is incomplete compared to Chrome Android; treat Chromium as the primary target.
- **Permissions:** denied camera/mic must be re-enabled in site settings; the UI surfaces this.
- **Storage quotas:** large projects can hit IndexedDB quotas; the soft 6-project cap helps.
- **Background tabs:** recording should stay in the foreground; browsers may throttle capture.

## Privacy

- No telemetry, analytics, or accounts.
- No clip upload endpoints exist in this app.
- Share/export uses user-gesture download or the Web Share API only.

## Scripts

| Command           | Purpose                     |
|-------------------|-----------------------------|
| `npm run dev`     | Vite dev server             |
| `npm run build`   | Typecheck + production bundle |
| `npm run preview` | Preview production build    |
| `npm test`        | Vitest storage/unit tests   |
