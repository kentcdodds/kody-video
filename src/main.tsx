import { createRoot } from 'remix/ui'
import { App } from './app'
import { initErrorReporting, reportComponentError } from './lib/error-reporting'
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

const root = createRoot(document.getElementById('root')!)
root.addEventListener('error', (event) => {
  reportComponentError(event.error)
})
root.render(<App />)
