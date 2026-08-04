import type { Handle, RemixNode } from 'remix/ui'

type PageComponent = (handle: Handle<any>) => () => RemixNode

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

  return function LazyPage(handle: Handle<Record<string, unknown>>) {
    if (!Page && !loadError) {
      loading ??= loader()
        .then((mod) => {
          const exported = mod[exportName]
          if (!exported) throw new Error(`Lazy page export "${exportName}" missing`)
          Page = exported
          void handle.update()
        })
        .catch((err: unknown) => {
          loadError = err instanceof Error ? err : new Error(String(err))
          void handle.update()
        })
    }

    return () => {
      if (loadError) {
        return (
          <div className="screen legal-screen">
            <p className="muted">Could not load this screen. Reload and try again.</p>
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
