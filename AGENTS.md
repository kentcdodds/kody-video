# AGENTS.md

Kody Video is a mobile-first, client-side PWA "clips camera": you hold on the
live camera preview to record clips, arrange/trim them on a filmstrip timeline,
and export/share one video file. Everything runs on-device (camera capture,
editing, encoding). There are no accounts, uploads, or clip-storage backend.
The only server-side surface is one Cloudflare Pages Function
(`functions/api/verify-purchase.ts`) that verifies a Stripe session for the
optional "Kody Video Plus" purchase.

See `README.md` for the full architecture, scripts table, and product details.

## Cursor Cloud specific instructions

### Node version
- This project requires Node `>=24.3.0` (the pinned `remix@3.0.0-beta.5` engine).
  Node 24 is installed via `nvm` and made the default. The VM also ships a
  system Node 22 at `/exec-daemon/node` that would otherwise win on `PATH`, so
  `~/.bashrc` prepends the nvm Node 24 `bin` to `PATH`. New shells get Node 24
  automatically; if you spawn a non-login shell and see Node 22, run
  `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`.

### Dependencies / install caveats
- npm 11 (bundled with Node 24) prints `allow-scripts` warnings for blocked
  postinstall scripts (`esbuild`, `@sentry/cli`). This is safe to ignore:
  esbuild works via its `@esbuild/linux-x64` optional dependency, and
  `@sentry/cli` is only needed for source-map upload at build time (skipped
  unless `SENTRY_AUTH_TOKEN` is set). `npm run build`/`dev`/`test` all work
  without approving those scripts.

### Running / testing (standard commands live in `README.md` / `package.json`)
- Dev server: `npm run dev` (Vite, port 5173). The Playwright e2e suite starts
  its own dev server on port 4189, so it can run alongside `npm run dev`.
- Lint/typecheck: `npm run lint` (`tsc -b`). Unit tests: `npm test` (Vitest).
- E2e/smoke tests need Playwright's Chromium browser installed
  (`npx playwright install chromium`); the update script handles this.

### Manual GUI / camera testing in the cloud VM (non-obvious)
- The VM has no real camera or microphone. To exercise the camera/record/export
  flow in a real browser, launch Chrome with fake-media flags, e.g.:
  `DISPLAY=:1 google-chrome --use-fake-device-for-media-stream --use-fake-ui-for-media-stream --user-data-dir=/tmp/chrome-profile http://localhost:5173/`.
  Without these flags the app correctly shows a "No camera was found" error.
- With the fake camera, the preview is a synthetic green test pattern and a
  red "Mic isn't picking up sound" warning appears during recording — both are
  expected in this environment and are not bugs.
- On Linux/Chromium the export falls back to WebM (no MP4 hardware encoder);
  MP4 (H.264/AAC) is preferred only where the platform exposes those encoders.
