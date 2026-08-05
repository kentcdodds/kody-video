/**
 * Served (via _redirects) for any /assets/* URL that no longer exists.
 *
 * A client that kept a previous deploy's HTML shell imports its retired
 * hashed entry chunk; before this file existed the SPA fallback answered
 * with index.html and the module import died on the HTML MIME type — the
 * app never mounted (static hero, no projects) and, because the app never
 * booted, it could never accept the waiting service worker update either.
 *
 * Being real JavaScript, this module executes in that import and recovers:
 * drop the stale service worker registration and Cache Storage (never
 * IndexedDB — projects and clips are untouched), then reload so the fresh
 * shell and worker take over. Guarded to run at most once per session.
 */
const KEY = 'kody:boot-entry-reload'
try {
  let ranBefore = false
  try {
    ranBefore = sessionStorage.getItem(KEY) !== null
    if (!ranBefore) sessionStorage.setItem(KEY, '1')
  } catch {
    ranBefore = true
  }
  if (!ranBefore) {
    const regs = await (navigator.serviceWorker?.getRegistrations?.() ?? [])
    await Promise.all(regs.map((reg) => reg.unregister()))
    const keys = await (self.caches?.keys?.() ?? [])
    await Promise.all(keys.map((key) => caches.delete(key)))
    location.reload()
  }
} catch {
  // Recovery is best-effort; a plain reload attempt is still better than
  // leaving the dead shell up.
}
