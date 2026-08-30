import type { Handle } from 'remix/ui'
import { on } from 'remix/ui'
import { registerSW } from 'virtual:pwa-register'
import { BackupDropOverlay } from './components/backup-drop-overlay'
import { lazyPage } from './components/lazy-page'
import { applyWaitingUpdate, registerUpdateHandles } from './lib/app-update'
import { Router } from './router'
import { HomePage } from './pages/home-page'

const ProjectPage = lazyPage(() => import('./pages/project-page'), 'ProjectPage')
const UnlockedPage = lazyPage(() => import('./pages/unlocked-page'), 'UnlockedPage')
const AboutPage = lazyPage(() => import('./pages/about-page'), 'AboutPage')
const PrivacyPage = lazyPage(() => import('./pages/privacy-page'), 'PrivacyPage')
const TermsPage = lazyPage(() => import('./pages/terms-page'), 'TermsPage')
const ReceivePage = lazyPage(() => import('./pages/receive-page'), 'ReceivePage')

export function App(handle: Handle) {
  let needRefresh = false

  const updateServiceWorker = registerSW({
    immediate: true,
    onNeedRefresh() {
      needRefresh = true
      void handle.update()
    },
    // vite-plugin-pwa reloads on `controlling` unless we take this hook.
    // A blind location.reload() there (and the old 1.5s fallback) is what
    // left installed PWAs on the previous shell after tapping Update.
    onNeedReload() {
      // Reload is owned by applyWaitingUpdate.
    },
    onRegisteredSW(_url, registration) {
      registerUpdateHandles(
        registration,
        (reload) => updateServiceWorker(reload),
        () => {
          needRefresh = true
          void handle.update()
        },
      )
    },
  })

  const applyUpdate = () => {
    needRefresh = false
    void handle.update()
    void applyWaitingUpdate()
      .then((result) => {
        if (result === 'updated') return
        needRefresh = true
        void handle.update()
      })
      .catch(() => {
        needRefresh = true
        void handle.update()
      })
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
          '/unlocked/:code': (params) => <UnlockedPage code={params.code ?? ''} />,
          '/about': () => <AboutPage />,
          '/privacy': () => <PrivacyPage />,
          '/terms': () => <TermsPage />,
          '/receive': () => <ReceivePage />,
          '/receive/:code': (params) => <ReceivePage code={params.code ?? ''} />,
        }}
      />
      <BackupDropOverlay />
      {needRefresh ? (
        <div className="update-toast" role="status">
          <span>
            <button type="button" mix={on('click', applyUpdate)}>
              Update
            </button>{' '}
            available
          </span>
        </div>
      ) : null}
    </div>
  )
}
