/**
 * Installed-PWA first paint. The iOS standalone WebView keeps its default
 * white splash until the document paints, and a hung or wiped cache leaves
 * that splash up forever. These helpers are the pit-of-success: serve the
 * last-known shell, never wait on the network to show UI, never delete the
 * only copy of the app while the origin is unreachable.
 */

/** Network-only stamp. Precache and navigateFallback both skip it. */
export const ORIGIN_PROBE_URL = '/version.json'
const ORIGIN_PROBE_MS = 2_500

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

export type OriginProbe = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Boot-recovery and lazy-chunk recovery unregister the service worker and
 * drop Cache Storage so a poisoned HTTP cache can be re-fetched. That is
 * fatal when the origin cannot replace the files: the precache is the only
 * copy of the shell, and wiping it is the white screen of death.
 *
 * `navigator.onLine` is not enough — a phone can sit on Wi-Fi with no
 * upstream and still report online. Require a live same-origin probe
 * (`/version.json`, network-only) before any purge. IndexedDB is never
 * in this path.
 */
export async function canPurgeCachesOnRecover(options?: {
  onLine?: boolean
  fetchImpl?: OriginProbe
}): Promise<boolean> {
  const onLine = options?.onLine ?? (typeof navigator !== 'undefined' ? navigator.onLine : true)
  if (onLine === false) return false
  const fetchFn = options?.fetchImpl ?? (typeof fetch === 'function' ? fetch : null)
  if (!fetchFn) return false
  try {
    const res = await fetchWithTimeout(
      fetchFn,
      ORIGIN_PROBE_URL,
      { cache: 'no-store', headers: { accept: 'application/json' } },
      ORIGIN_PROBE_MS,
    )
    return res.ok
  } catch {
    return false
  }
}

function fetchWithTimeout(
  fetchFn: OriginProbe,
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out fetching ${url}`)), ms)
    void fetchFn(url, init).then(
      (res) => {
        clearTimeout(timer)
        resolve(res)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}
