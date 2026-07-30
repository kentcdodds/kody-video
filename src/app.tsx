import { RouterProvider } from 'react-router-dom'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { registerUpdateHandles } from './lib/app-update'
import { router } from './router'

export function App() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    onRegisteredSW(_url, registration) {
      // Fires async, after this hook call settles — the closure is safe.
      registerUpdateHandles(registration, (reload) => updateServiceWorker(reload))
    },
  })

  const applyUpdate = () => {
    setNeedRefresh(false)
    void updateServiceWorker(true).catch(() => undefined)
    // clientsClaim + controllerchange normally reload the page. Workers
    // deployed before clientsClaim never fire controllerchange, so tapping
    // Update "did nothing" — the forced reload is what rescues those
    // sessions (the new worker IS active by then; a reload runs under it).
    window.setTimeout(() => {
      window.location.reload()
    }, 1500)
  }

  return (
    <div className="app-shell">
      <RouterProvider router={router} />
      {needRefresh ? (
        <div className="update-toast" role="status">
          <span>A new version of Kody Video is ready</span>
          <button type="button" onClick={applyUpdate}>
            Update
          </button>
        </div>
      ) : null}
    </div>
  )
}
