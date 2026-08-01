import { Navigate, createBrowserRouter } from 'react-router-dom'
import { AboutPage, aboutLoader } from './pages/about-page'
import { HomePage, homeLoader } from './pages/home-page'
import { PrivacyPage } from './pages/privacy-page'
import { ProjectPage, projectLoader } from './pages/project-page'
import { TermsPage } from './pages/terms-page'
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
    path: '/about',
    element: <AboutPage />,
    loader: aboutLoader,
  },
  {
    path: '/privacy',
    element: <PrivacyPage />,
  },
  {
    path: '/terms',
    element: <TermsPage />,
  },
  {
    path: '*',
    element: <Navigate to="/" replace />,
  },
])
