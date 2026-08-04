import './lib/install-prompt.js'
import { initErrorReporting } from './lib/error-reporting.js'
import { sweepExportCache } from './lib/export/export-cache.js'
import { h } from './dom.js'
import './app.js'

initErrorReporting()
// Export temp files and zip scratch can be gigabytes; reclaim anything no
// longer referenced. No export can be running at boot, so this is safe.
void sweepExportCache().catch(() => undefined)

document.getElementById('root').replaceChildren(h('kv-app'))
