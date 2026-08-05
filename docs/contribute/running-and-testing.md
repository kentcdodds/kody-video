# Running & testing

The canonical command list lives in `README.md` and `package.json`. Notes below
cover the non-obvious bits.

## Dev server

`npm run dev` starts Vite on port `5173`. The Playwright e2e suite starts its
own dev server on port `4189`, so `npm run test:e2e` can run alongside a
`npm run dev` session.

## Lint / unit tests

- Lint & typecheck: `npm run lint` (`tsc -b`).
- Unit tests: `npm test` (Vitest browser mode — tests run in headless
  Chromium against real browser APIs: IndexedDB, localStorage, AudioContext).

Vitest browser-mode notes:

- The suite needs Playwright's Chromium installed (same install as e2e, see
  below).
- Test-side code runs in the browser, so Node APIs are unavailable in test
  files. Anything that genuinely needs Node (e.g. running ffmpeg for the MP4
  metadata test) lives in a [custom command](https://vitest.dev/api/browser/commands)
  (`src/test/ffmpeg-command.ts`) that executes on the Vitest server.
- `vi.resetModules()` does not invalidate the browser module graph. Modules
  with test-relevant module-level state export explicit reset helpers instead
  (`resetRecordingMimeTypeForTests`, `resetMicMonitorForTests`,
  `resetAppUpdateForTests`, `__resetDbForTests`).

## End-to-end / smoke tests

`npm test` (browser mode), `npm run test:e2e` (Playwright), and
`npm run test:smoke` need Playwright's Chromium browser installed:

```bash
npx playwright install chromium
```

The e2e suite runs with a fake camera/mic, so it does not need real hardware.
See [manual-camera-testing.md](./manual-camera-testing.md) for driving the
camera/record/export flow manually in a headless environment.
