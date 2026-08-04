# Running & testing

The canonical command list lives in `README.md` and `package.json`. Notes below
cover the non-obvious bits.

## Dev server

`npm run dev` starts Vite on port `5173`. The Playwright e2e suite starts its
own dev server on port `4189`, so `npm run test:e2e` can run alongside a
`npm run dev` session.

## Lint / unit tests

- Lint & typecheck: `npm run lint` (`tsc -b`).
- Unit tests: `npm test` (Vitest).

## End-to-end / smoke tests

`npm run test:e2e` (Playwright) and `npm run test:smoke` need Playwright's
Chromium browser installed:

```bash
npx playwright install chromium
```

The e2e suite runs with a fake camera/mic, so it does not need real hardware.
See [manual-camera-testing.md](./manual-camera-testing.md) for driving the
camera/record/export flow manually in a headless environment.
