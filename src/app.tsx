import type { Handle } from 'remix/ui'
import { on } from 'remix/ui'
import { registerSW } from 'virtual:pwa-register'
import { lazyPage } from './components/lazy-page'
import { registerUpdateHandles } from './lib/app-update'
import { Router } from './router'
import { HomePage } from './pages/home-page'

const ProjectPage = lazyPage(() => import('./pages/project-page'), 'ProjectPage')
const UnlockedPage = lazyPage(() => import('./pages/unlocked-page'), 'UnlockedPage')
const AboutPage = lazyPage(() => import('./pages/about-page'), 'AboutPage')
const PrivacyPage = lazyPage(() => import('./pages/privacy-page'), 'PrivacyPage')
const TermsPage = lazyPage(() => import('./pages/terms-page'), 'TermsPage')

export function App(handle: Handle) {
  let needRefresh = false

  const updateServiceWorker = registerSW({
    immediate: true,
    onNeedRefresh() {
      needRefresh = true
      void handle.update()
    },
    onRegisteredSW(_url, registration) {
      registerUpdateHandles(registration, (reload) => updateServiceWorker(reload))
    },
  })

  const applyUpdate = () => {
    needRefresh = false
    void handle.update()
    void updateServiceWorker(true).catch(() => undefined)
    // clientsClaim + controllerchange normally reload the page. Workers
    // deployed before clientsClaim never fire controllerchange, so tapping
    // Update "did nothing" — the forced reload is what rescues those
    // sessions (the new worker IS active by then; a reload runs under it).
    window.setTimeout(() => {
      window.location.reload()
    }, 1500)
  }

  return () => (
    <div className="app-shell">
      <Router
        routes={{
          '/': () => <HomePage />,
          '/project/:projectId': (params) => (
            <ProjectPage projectId={params.projectId ?? ''} />
          ),
          '/unlocked': () => <UnlockedPage />,
          '/about': () => <AboutPage />,
          '/privacy': () => <PrivacyPage />,
          '/terms': () => <TermsPage />,
        }}
      />
      {needRefresh ? (
        <div className="update-toast" role="status">
          <span>A new version of Kody Video is ready</span>
          <button type="button" mix={on('click', applyUpdate)}>
            Update
          </button>
        </div>
      ) : null}
    </div>
  )
}
