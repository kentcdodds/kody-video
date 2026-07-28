import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import { initErrorReporting, reactRootErrorHandlers } from './lib/error-reporting'
import './lib/install-prompt'
import './styles/global.css'
import './styles/home.css'
import './styles/record.css'
import './styles/editor.css'

initErrorReporting()

createRoot(document.getElementById('root')!, reactRootErrorHandlers).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
