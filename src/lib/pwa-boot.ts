/**
 * Installed-PWA first paint. The iOS standalone WebView keeps its default
 * white splash until the document paints, and a hung or wiped cache leaves
 * that splash up forever. These helpers are the pit-of-success: serve the
 * last-known shell, never wait on the network to show UI, never delete the
 * only copy of the app while airplane mode is on.
 */

/**
 * Two-frame boot delay exists so a browser-tab LCP image can paint before
 * the main bundle evaluates. An installed app has no LCP budget — it must
 * evaluate the cached shell on this turn.
 */
export function shouldDelayBootForLcp(standalone: boolean): boolean {
  return !standalone
}

/**
 * Production CSS is a dynamic import() (kept out of index.html for LCP).
 * Browser tabs still wait so the first SPA tree is not unstyled. Standalone
 * must not: a CSS fetch that waits on the network holds the iOS splash.
 */
export function shouldAwaitStylesBeforePaint(standalone: boolean): boolean {
  return !standalone
}

/**
 * Boot-recovery and lazy-chunk recovery unregister the service worker and
 * drop Cache Storage so a poisoned HTTP cache can be re-fetched. That is
 * fatal offline: the precache is the only copy of the shell, and wiping it
 * is the white screen of death. IndexedDB is never in this path.
 */
export function shouldPurgeCachesOnRecover(onLine: boolean): boolean {
  return onLine
}
