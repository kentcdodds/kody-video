import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import './lib/install-prompt'
import './styles/global.css'
import './styles/home.css'
import './styles/record.css'
import './styles/editor.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
