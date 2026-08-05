import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'
import { probeMp4WithFfmpeg } from './src/test/ffmpeg-command'

export default defineConfig({
  // Pre-bundle everything the component tests pull in — a dependency
  // discovered mid-run makes Vite reload the page and re-run tests.
  optimizeDeps: {
    include: ['remix/ui/jsx-dev-runtime'],
  },
  test: {
    // Unit tests only — tests/e2e belongs to Playwright.
    include: ['src/**/*.test.ts', 'functions/**/*.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      // Unit-style assertions — a page screenshot of a failure adds noise.
      screenshotFailures: false,
      commands: { probeMp4WithFfmpeg },
    },
  },
})
