import type { Handle, RemixNode } from 'remix/ui'
import { on } from 'remix/ui'
import { reportError } from '../lib/error-reporting'

type PageComponent = (handle: Handle<any>) => () => RemixNode

/** sessionStorage flag so a failed chunk load auto-reloads at most once. */
export const LAZY_CHUNK_RELOAD_KEY = 'kody:lazy-chunk-reload'

/** True when a hashed lazy chunk failed to load (Chrome/Vite, webpack, Safari). */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    /Failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /Loading chunk [\w-]+ failed/i.test(message) ||
    // Safari / WebKit (including installed iOS PWAs)
    /Importing a module script failed/i.test(message)
  )
}

/**
 * Load a route page module on first visit. Keeps the home shell free of
 * camera/editor/export code (and mediabunny) until the user opens a project
 * or a secondary page.
 */
export function lazyPage(
  loader: () => Promise<Record<string, PageComponent>>,
  exportName: string,
): PageComponent {
  let Page: PageComponent | null = null
  let loadError: Error | null = null
  let loading: Promise<void> | null = null

  const clearReloadGuard = () => {
    try {
      sessionStorage.removeItem(LAZY_CHUNK_RELOAD_KEY)
    } catch {
      // private mode / blocked storage
    }
  }

  const tryAutoReloadOnce = (err: unknown): boolean => {
    if (!isChunkLoadError(err)) return false
    try {
      if (sessionStorage.getItem(LAZY_CHUNK_RELOAD_KEY)) return false
      sessionStorage.setItem(LAZY_CHUNK_RELOAD_KEY, '1')
    } catch {
      return false
    }
    // A failed chunk can be worse than a stale hash: during a deploy window
    // the response for a chunk URL could be cached wrong in the HTTP cache
    // OR in the service worker's install-time precache (which intercepts
    // fetches, so an HTTP reprime alone cannot reach past it). Recovery
    // drops the worker + Cache Storage (never IndexedDB), re-primes the
    // HTTP cache for the shell and the failing chunk, then reloads — all
    // best-effort with a short deadline so the reload is never held
    // hostage by a slow network.
    const message = err instanceof Error ? err.message : String(err)
    const chunkUrl = message.match(/https?:\/\/\S+\/assets\/\S+?\.js/)?.[0]
    const recover = (async () => {
      try {
        const regs = await (navigator.serviceWorker?.getRegistrations?.() ?? [])
        await Promise.all(regs.map((reg) => reg.unregister()))
        const keys = await (self.caches?.keys?.() ?? [])
        await Promise.all(keys.map((key) => caches.delete(key)))
      } catch {
        // storage access blocked — the reload below is still worth trying
      }
      await Promise.allSettled(
        ['/', ...(chunkUrl ? [chunkUrl] : [])].map((url) => fetch(url, { cache: 'reload' })),
      )
    })()
    void Promise.race([recover, new Promise((resolve) => setTimeout(resolve, 4000))]).then(() => {
      location.reload()
    })
    return true
  }

  return function LazyPage(handle: Handle<Record<string, unknown>>) {
    if (!Page && !loadError) {
      loading ??= loader()
        .then((mod) => {
          const exported = mod[exportName]
          if (!exported) throw new Error(`Lazy page export "${exportName}" missing`)
          Page = exported
          clearReloadGuard()
          void handle.update()
        })
        .catch((err: unknown) => {
          reportError(err, 'lazy-page', { exportName })
          // After a deploy, the shell can briefly point at retired chunk
          // hashes. One automatic reload usually picks up the new assets.
          if (tryAutoReloadOnce(err)) return
          loadError = err instanceof Error ? err : new Error(String(err))
          void handle.update()
        })
    }

    return () => {
      if (loadError) {
        return (
          <div className="screen legal-screen">
            <p className="muted">Could not load this screen.</p>
            <div style={{ marginTop: '16px' }}>
              <button
                type="button"
                className="btn btn-secondary"
                mix={on('click', () => {
                  loadError = null
                  loading = null
                  void handle.update()
                })}
              >
                Try again
              </button>
              {' '}
              <button
                type="button"
                className="btn btn-primary"
                mix={on('click', () => {
                  location.reload()
                })}
              >
                Reload
              </button>
            </div>
          </div>
        )
      }
      if (!Page) {
        return <div className="screen" aria-busy="true" />
      }
      const Loaded = Page
      return <Loaded {...handle.props} />
    }
  }
}
