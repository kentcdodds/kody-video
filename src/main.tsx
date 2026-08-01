import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import { initErrorReporting, reactRootErrorHandlers } from './lib/error-reporting'
import { sweepExportCache } from './lib/export/export-cache'
import './lib/install-prompt'
import './styles/global.css'
import './styles/home.css'
import './styles/record.css'
import './styles/editor.css'

initErrorReporting()
// Export temp files and zip scratch can be gigabytes; reclaim anything no
// longer referenced. No export can be running at boot, so this is safe.
void sweepExportCache().catch(() => undefined)

createRoot(document.getElementById('root')!, reactRootErrorHandlers).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
