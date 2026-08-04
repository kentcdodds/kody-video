import type { Handle } from 'remix/ui'
import { on } from 'remix/ui'
import { registerSW } from 'virtual:pwa-register'
import { registerUpdateHandles } from './lib/app-update'
import { Router } from './router'
import { AboutPage } from './pages/about-page'
import { HomePage } from './pages/home-page'
import { PrivacyPage } from './pages/privacy-page'
import { ProjectPage } from './pages/project-page'
import { TermsPage } from './pages/terms-page'
import { UnlockedPage } from './pages/unlocked-page'

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
          '/project/:projectId': (params) => <ProjectPage projectId={params.projectId ?? ''} />,
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
