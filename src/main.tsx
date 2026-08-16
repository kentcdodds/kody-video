// Must run before Router / @remix-run/route-pattern (KODY-VIDEO-M).
import './lib/array-at-polyfill'
import { createRoot } from 'remix/ui'
import { App } from './app'
import { stripUpdateNavigationMark } from './lib/app-update'
import { initErrorReporting, reportComponentError } from './lib/error-reporting'
import { sweepExportCache } from './lib/export/export-cache'
import { onNavigate } from './router'
import './lib/install-prompt'

stripUpdateNavigationMark()
initErrorReporting()
// Export temp files and zip scratch can be gigabytes; reclaim anything no
// longer referenced. No export can be running at boot, so this is safe.
void sweepExportCache().catch(() => undefined)

const appEl = document.getElementById('app')
if (!appEl) throw new Error('#app mount point missing')

/**
 * Per-route document chrome: hide the HTML boot hero on non-home routes,
 * and keep the shell-layout attribute (see index.html's pre-paint script)
 * in step with navigation. Home and static pages are 'adaptive' (wide on
 * landscape viewports); project pages own the attribute themselves — the
 * width there depends on the project's locked orientation, which only the
 * project page knows.
 */
function syncRouteChrome(): void {
  const path = window.location.pathname
  const home = path === '/' || path === ''
  document.documentElement.dataset.route = home ? 'home' : 'app'
  // Project routes start narrow — the phone-column default — so a wide
  // adaptive page (landscape home) can't linger over a portrait project
  // while its data loads. The project page upgrades to 'wide' as soon as it
  // knows the project is landscape-locked (same brief narrow-first paint a
  // hard reload of a landscape project has).
  document.documentElement.dataset.shell = path.startsWith('/project/')
    ? 'narrow'
    : 'adaptive'
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
  syncRouteChrome()
  onNavigate({ signal: new AbortController().signal }, syncRouteChrome)
})

// Fonts after first paint so ~74KB of woff2 never contends with LCP.
// Swallow preload failures (deploy-window / cache races): system fonts are
// fine, and an unhandled rejection here was opening Sentry issues (KODY-VIDEO-J).
const loadFonts = () => {
  void import('./styles/fonts.css').catch(() => undefined)
}
if (document.readyState === 'complete') {
  loadFonts()
} else {
  window.addEventListener('load', loadFonts, { once: true })
}
