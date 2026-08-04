/**
 * Minimal client-side router for a pure SPA.
 *
 * The app's data lives in IndexedDB, so there is nothing to preload from a
 * server on navigation — pages own their data loading. All this router does
 * is keep `location.pathname` in sync with which page renders:
 * pushState/replaceState + popstate + same-origin link interception.
 */

const routerEvents = new EventTarget()
let interceptInstalled = false

function notify() {
  routerEvents.dispatchEvent(new Event('navigate'))
}

export function navigate(to, options = {}) {
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

function shouldInterceptClick(event, anchor) {
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

export function installIntercepts() {
  if (interceptInstalled) return
  interceptInstalled = true
  document.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a') : null
    if (!anchor || !shouldInterceptClick(event, anchor)) return
    event.preventDefault()
    const destination = new URL(anchor.href, window.location.href)
    navigate(`${destination.pathname}${destination.search}${destination.hash}`)
  })
  window.addEventListener('popstate', notify)
}

export function onNavigate(signal, listener) {
  installIntercepts()
  routerEvents.addEventListener('navigate', listener, { signal })
}

/** Match the current pathname to a page. Route patterns are so few that a
 * hand-rolled matcher beats pulling in URLPattern portability concerns. */
export function matchRoute(pathname) {
  if (pathname === '/') return { page: 'home' }
  const project = pathname.match(/^\/project\/([^/]+)\/?$/)
  if (project) return { page: 'project', projectId: decodeURIComponent(project[1]) }
  if (/^\/unlocked\/?$/.test(pathname)) return { page: 'unlocked' }
  if (/^\/about\/?$/.test(pathname)) return { page: 'about' }
  if (/^\/privacy\/?$/.test(pathname)) return { page: 'privacy' }
  if (/^\/terms\/?$/.test(pathname)) return { page: 'terms' }
  return null
}
