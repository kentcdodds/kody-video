import './lib/install-prompt.ts'
import { initErrorReporting } from './lib/error-reporting.ts'
import { sweepExportCache } from './lib/export/export-cache.ts'
import { h } from './dom.ts'
import './app.ts'

initErrorReporting()
// Export temp files and zip scratch can be gigabytes; reclaim anything no
// longer referenced. No export can be running at boot, so this is safe.
void sweepExportCache().catch(() => undefined)

document.getElementById('root')?.replaceChildren(h('kv-app'))
