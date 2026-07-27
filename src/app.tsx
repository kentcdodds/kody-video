import { RouterProvider } from 'react-router-dom'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { router } from './router'

export function App() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({ immediate: true })

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
