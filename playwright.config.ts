import { defineConfig, devices } from '@playwright/test'

/**
 * E2E suite — automates the browser-checkable parts of
 * manual-test-checklist.md. Camera and microphone come from Chromium's fake
 * media stack, so recording, editing, playback, and export all run for real
 * (only true hardware behavior — torch, zoom optics, share sheets — stays
 * on the manual list).
 *
 * Run: npm run test:e2e
 */
const PORT = 4189

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  // Recording + export tests do real encoding work.
  timeout: 90_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    permissions: ['camera', 'microphone'],
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  projects: [
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 7'],
        // Mouse-driven pointer events: the app listens to pointerdown, and
        // desktop-style input keeps hold/drag gestures deterministic.
        isMobile: false,
        hasTouch: false,
        defaultBrowserType: 'chromium',
      },
      testIgnore: /desktop-keyboard/,
    },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1100, height: 800 } },
      testMatch: /desktop-keyboard/,
    },
  ],
  webServer: {
    // Dev server (not preview): specs seed state by importing /src modules
    // in-page, which needs vite transforms.
    command: `npm run dev -- --host 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
