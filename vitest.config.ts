import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Unit tests only — tests/e2e belongs to Playwright.
    include: ['src/**/*.test.ts', 'functions/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
  },
})
