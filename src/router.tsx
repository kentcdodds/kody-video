import { createMultiMatcher } from 'remix/route-pattern/match'
import type { Handle, RemixNode } from 'remix/ui'

/**
 * Minimal client-side router for a pure SPA.
 *
 * The app's data lives in IndexedDB, so there is nothing to preload from a
 * server on navigation — pages own their data loading. All this router does
 * is keep `location.pathname` in sync with which page component renders:
 * pushState/replaceState + popstate + same-origin link interception.
 */

export type RouteParams = Record<string, string>

const routerEvents = new EventTarget()
let interceptInstalled = false

function notify() {
  routerEvents.dispatchEvent(new Event('navigate'))
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const destination = new URL(to, window.location.href)
  if (destination.origin !== window.location.origin) {
    window.location.assign(destination.toString())
    return
  }
  const nextPath = `${destination.pathname}${destination.search}${destination.hash}`
  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (nextPath === currentPath) return
  if (options.replace) {
    window.history.replaceState({}, '', nextPath)
  } else {
    window.history.pushState({}, '', nextPath)
  }
  window.scrollTo(0, 0)
  notify()
}

function shouldInterceptClick(event: MouseEvent, anchor: HTMLAnchorElement): boolean {
  if (event.defaultPrevented) return false
  if (event.button !== 0) return false
  if (event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return false
  if (anchor.target && anchor.target !== '_self') return false
  if (anchor.hasAttribute('download')) return false
  const href = anchor.getAttribute('href')
  if (!href || href.startsWith('#')) return false
  const destination = new URL(anchor.href, window.location.href)
  return destination.origin === window.location.origin
}

function installIntercepts() {
  if (interceptInstalled) return
  interceptInstalled = true
  document.addEventListener('click', (event) => {
    const anchor = (event.target as Element | null)?.closest('a')
    if (!anchor || !shouldInterceptClick(event, anchor)) return
    event.preventDefault()
    const destination = new URL(anchor.href, window.location.href)
    navigate(`${destination.pathname}${destination.search}${destination.hash}`)
  })
  window.addEventListener('popstate', notify)
}

export function onNavigate(handle: Pick<Handle, 'signal'>, listener: () => void): void {
  installIntercepts()
  routerEvents.addEventListener('navigate', listener, { signal: handle.signal })
}

type RouterProps = {
  routes: Record<string, (params: RouteParams) => RemixNode>
}

export function Router(handle: Handle<RouterProps>) {
  const matcher = createMultiMatcher<(params: RouteParams) => RemixNode>()
  for (const [pattern, page] of Object.entries(handle.props.routes)) {
    matcher.add(pattern, page)
  }

  onNavigate(handle, () => void handle.update())

  return () => {
    const match = matcher.match(new URL(window.location.href))
    if (!match) {
      // Unknown paths bounce home, like the old `*` route.
      handle.queueTask(() => navigate('/', { replace: true }))
      return null
    }
    const params: RouteParams = {}
    for (const [name, value] of Object.entries(match.params)) {
      if (typeof value === 'string') params[name] = value
    }
    return match.data(params)
  }
}
