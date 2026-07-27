import { Navigate, createBrowserRouter } from 'react-router-dom'
import { HomePage, homeLoader } from './pages/home-page'
import { ProjectPage, projectLoader } from './pages/project-page'
import { UnlockedPage, unlockedLoader } from './pages/unlocked-page'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <HomePage />,
    loader: homeLoader,
  },
  {
    path: '/project/:projectId',
    element: <ProjectPage />,
    loader: projectLoader,
  },
  {
    path: '/unlocked',
    element: <UnlockedPage />,
    loader: unlockedLoader,
  },
  {
    path: '*',
    element: <Navigate to="/" replace />,
  },
])
