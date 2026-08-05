// Must run before Router / @remix-run/route-pattern (KODY-VIDEO-M).
import './lib/array-at-polyfill'
import { createRoot } from 'remix/ui'
import { App } from './app'
import { initErrorReporting, reportComponentError } from './lib/error-reporting'
import { sweepExportCache } from './lib/export/export-cache'
import { onNavigate } from './router'
import './lib/install-prompt'

initErrorReporting()
// Export temp files and zip scratch can be gigabytes; reclaim anything no
// longer referenced. No export can be running at boot, so this is safe.
void sweepExportCache().catch(() => undefined)

const appEl = document.getElementById('app')
if (!appEl) throw new Error('#app mount point missing')

/** Hide the HTML boot hero on non-home routes (never touch it on home). */
function syncBootHeroRoute(): void {
  const home = window.location.pathname === '/' || window.location.pathname === ''
  document.documentElement.dataset.route = home ? 'home' : 'app'
}

// Styles load before the first SPA paint so we do not flash an unstyled
// tree (that was a large desktop CLS). Vite keeps them out of index.html
// (see lcp-first-paint plugin); the boot hero already painted via inline CSS.
await Promise.all([import('./styles/global.css'), import('./styles/home.css')])

const root = createRoot(appEl)
root.addEventListener('error', (event) => {
  reportComponentError(event.error)
})
root.render(<App />)

queueMicrotask(() => {
  syncBootHeroRoute()
  onNavigate({ signal: new AbortController().signal }, syncBootHeroRoute)
})

// Fonts after first paint so ~74KB of woff2 never contends with LCP.
const loadFonts = () => {
  void import('./styles/fonts.css')
}
if (document.readyState === 'complete') {
  loadFonts()
} else {
  window.addEventListener('load', loadFonts, { once: true })
}
