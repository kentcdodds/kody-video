/**
 * App shell: route outlet + service-worker update toast.
 */

import { define, h, KvElement } from './dom.ts'
import { registerUpdateHandles } from './lib/app-update.ts'
import { matchRoute, navigate, onNavigate } from './router.ts'
import { KvProjectPage } from './pages/project-page.ts'
import './pages/about-page.ts'
import './pages/home-page.ts'
import './pages/legal-pages.ts'
import './pages/unlocked-page.ts'

/**
 * Hand-rolled service worker registration with prompt-based updates: users
 * see "new version ready — update" instead of silently running stale code.
 */
type ApplyUpdate = (reloadPage?: boolean) => Promise<void>

function registerServiceWorker(onNeedRefresh: () => void): ApplyUpdate {
  let registration: ServiceWorkerRegistration | null = null

  const apply: ApplyUpdate = async (reloadPage = false) => {
    const waiting = registration?.waiting
    if (waiting) waiting.postMessage({ type: 'SKIP_WAITING' })
    if (reloadPage) {
      navigator.serviceWorker?.addEventListener(
        'controllerchange',
        () => {
          window.location.reload()
        },
        { once: true },
      )
    }
  }

  if (!('serviceWorker' in navigator)) {
    registerUpdateHandles(null, apply)
    return apply
  }

  void navigator.serviceWorker
    .register('/sw.js')
    .then((reg) => {
      registration = reg
      registerUpdateHandles(reg, apply)
      const watchInstalling = (worker: ServiceWorker | null) => {
        if (!worker) return
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            onNeedRefresh()
          }
        })
      }
      // An update may already be waiting from a previous visit.
      if (reg.waiting && navigator.serviceWorker.controller) onNeedRefresh()
      watchInstalling(reg.installing)
      reg.addEventListener('updatefound', () => watchInstalling(reg.installing))
    })
    .catch(() => undefined)
  return apply
}

export class KvApp extends KvElement<void> {
  #outlet: HTMLDivElement | null = null
  #toast: HTMLDivElement | null = null
  #currentPage: HTMLElement | null = null
  #currentPageName: string | null = null
  #updateServiceWorker: ApplyUpdate | null = null

  shellEl: HTMLDivElement | null = null

  override mounted(): void {
    this.#outlet = h('div', { style: { display: 'contents' } })
    this.#toast = null
    const shell = h('div', { className: 'app-shell' }, this.#outlet)
    this.replaceChildren(shell)
    this.shellEl = shell

    this.#updateServiceWorker = registerServiceWorker(() => this.#showUpdateToast())
    onNavigate(this.signal, () => this.#route())
    this.#route()
  }

  override render(): void {}

  #route(): void {
    const match = matchRoute(window.location.pathname)
    if (!match) {
      // Unknown paths bounce home, like the old `*` route.
      queueMicrotask(() => navigate('/', { replace: true }))
      return
    }

    // The project page survives in-place param changes (/project/new →
    // /project/<id> after lazy creation) so the camera never restarts.
    if (
      match.page === 'project' &&
      this.#currentPageName === 'project' &&
      this.#currentPage instanceof KvProjectPage
    ) {
      this.#currentPage.projectId = match.projectId
      return
    }
    if (match.page === this.#currentPageName && match.page !== 'project') return

    const tags = {
      home: 'kv-home-page',
      project: 'kv-project-page',
      unlocked: 'kv-unlocked-page',
      about: 'kv-about-page',
      privacy: 'kv-privacy-page',
      terms: 'kv-terms-page',
    }
    const page = document.createElement(tags[match.page])
    if (match.page === 'project' && page instanceof KvProjectPage) {
      page.projectId = match.projectId
    }
    this.#currentPage = page
    this.#currentPageName = match.page
    this.#outlet?.replaceChildren(page)
  }

  #showUpdateToast(): void {
    if (this.#toast) return
    this.#toast = h(
      'div',
      { className: 'update-toast', role: 'status' },
      h('span', null, 'A new version of Kody Video is ready'),
      h(
        'button',
        {
          type: 'button',
          onclick: () => {
            this.#toast?.remove()
            this.#toast = null
            void this.#updateServiceWorker?.(true).catch(() => undefined)
            // controllerchange normally reloads; the forced reload rescues
            // sessions where it never fires.
            window.setTimeout(() => {
              window.location.reload()
            }, 1500)
          },
        },
        'Update',
      ),
    )
    this.shellEl?.append(this.#toast)
  }
}
define('kv-app', KvApp)
