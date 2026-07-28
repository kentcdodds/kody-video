import { RouterProvider } from 'react-router-dom'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { registerUpdateHandles } from './lib/app-update'
import { router } from './router'

export function App() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    onRegisteredSW(_url, registration) {
      // Fires async, after this hook call settles — the closure is safe.
      registerUpdateHandles(registration, (reload) => updateServiceWorker(reload))
    },
  })

  return (
    <div className="app-shell">
      <RouterProvider router={router} />
      {needRefresh ? (
        <div className="update-toast" role="status">
          <span>A new version of Kody Video is ready</span>
          <button type="button" onClick={() => void updateServiceWorker(true)}>
            Update
          </button>
        </div>
      ) : null}
    </div>
  )
}
