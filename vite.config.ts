import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { sentryVitePlugin } from '@sentry/vite-plugin'

// Cloudflare Pages exposes the commit; local builds tag as 'dev'.
const commitSha = process.env.CF_PAGES_COMMIT_SHA ?? 'dev'
// Source maps upload only when the CI token is present (Cloudflare Pages env).
const sentryUpload = Boolean(process.env.SENTRY_AUTH_TOKEN)

export default defineConfig({
  define: {
    __COMMIT_SHA__: JSON.stringify(commitSha),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    // Open-source app: ship public source maps for DevTools / PSI, and still
    // upload the same maps to Sentry when the CI token is present.
    sourcemap: true,
    // Modern baselines only — matches Vite 7 defaults; keeps transforms lean.
    target: ['chrome107', 'edge107', 'firefox104', 'safari16'],
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'remix/ui',
  },
  plugins: [
    ...(sentryUpload
      ? [
          sentryVitePlugin({
            org: 'kent-c-dodds-tech-llc',
            project: 'kody-video',
            release: { name: commitSha },
            // Keep *.map in the Pages deploy so browsers can fetch them.
            sourcemaps: { filesToDeleteAfterUpload: [] },
          }),
        ]
      : []),
    {
      // First paint / LCP use inline critical CSS in index.html only. Strip
      // any Vite-injected stylesheet links so lantern does not model a
      // style-related LCP render delay; full CSS arrives via dynamic import()
      // from main.tsx. Defer the module entry by two frames so the LCP image
      // can paint before the main bundle evaluates.
      name: 'lcp-first-paint',
      transformIndexHtml(html) {
        const withoutCssLinks = html
          .replace(/<link rel="stylesheet"[^>]*>/g, '')
          .replace(/<link[^>]*as="style"[^>]*>/g, '')
          .replace(/<noscript><link rel="stylesheet"[^>]*><\/noscript>/g, '')
        return withoutCssLinks.replace(
          /<script type="module" crossorigin src="([^"]+)"><\/script>/,
          `<script type="module">
            const src = "$1";
            const boot = () => { import(src); };
            requestAnimationFrame(() => requestAnimationFrame(boot));
          </script>`,
        )
      },
    },
    VitePWA({
      // Prompt-based updates: users see "new version ready — update" instead
      // of silently running stale code until some future reload.
      registerType: 'prompt',
      includeAssets: [
        'favicon.png',
        'apple-touch-icon.png',
        'kody-mark.webp',
        'art/*.webp',
        'fonts/*.woff2',
        'robots.txt',
        'sitemap.xml',
        'llms.txt',
      ],
      manifest: {
        name: 'Kody Video',
        short_name: 'Kody Video',
        description:
          'Hold anywhere to record clips. Kody Video keeps projects private on your device until you share.',
        theme_color: '#2F3E46',
        background_color: '#2F3E46',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          {
            src: 'pwa-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'pwa-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Without clientsClaim the updated worker activates after
        // SKIP_WAITING but never takes over the open client —
        // `controllerchange` never fires, the update button appears to do
        // nothing, and the toast sticks until a full app restart.
        clientsClaim: true,
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,woff2}'],
        // Not part of the app shell: the social card is for link scrapers
        // and the icon master is only the source for generated icons.
        // Source maps are served on demand for debugging — do not precache.
        globIgnores: ['**/og-image.png', '**/art/kody-video-icon.png', '**/*.map'],
        navigateFallback: '/index.html',
        // Never SPA-fallback these: opening the social card in a tab with an
        // active service worker was "redirecting" to the app, and the API
        // must always hit the server.
        navigateFallbackDenylist: [
          /^\/api\//,
          /\/og-image\.png$/,
          /^\/robots\.txt$/,
          /^\/sitemap\.xml$/,
          /^\/llms\.txt$/,
          /^\/assets\//,
          /\.map$/,
        ],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
})
