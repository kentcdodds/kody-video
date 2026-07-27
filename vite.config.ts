import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Prompt-based updates: users see "new version ready — update" instead
      // of silently running stale code until some future reload.
      registerType: 'prompt',
      includeAssets: ['favicon.png', 'apple-touch-icon.png', 'kody-mark.webp', 'art/*.webp'],
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
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,woff2}'],
        // Not part of the app shell: the social card is for link scrapers
        // and the icon master is only the source for generated icons.
        globIgnores: ['**/og-image.png', '**/art/kody-video-icon.png'],
        navigateFallback: '/index.html',
        // Never SPA-fallback these: opening the social card in a tab with an
        // active service worker was "redirecting" to the app, and the API
        // must always hit the server.
        navigateFallbackDenylist: [/^\/api\//, /\/og-image\.png$/],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
})
