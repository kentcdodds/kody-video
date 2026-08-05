/**
 * Cloudflare Pages Function: on-device diagnostic for "the app shows only
 * the hero and no projects". Served under /api/ so no service worker or SPA
 * cache can interfere. Everything runs read-only in the visitor's browser
 * and prints facts on screen:
 *
 *  - whether this origin's IndexedDB holds projects/clips (proof the data
 *    is alive without needing the app to boot),
 *  - what shell HTML the HTTP cache serves vs what the network serves
 *    (stale-cache detection),
 *  - whether the current entry chunk downloads as real JavaScript,
 *  - whether a fresh copy of the app actually mounts (iframe probe).
 *
 * The Repair button drops service workers + Cache Storage (never
 * IndexedDB), re-primes the HTTP cache, and relaunches the app.
 */

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Kody Video — diagnostics</title>
    <style>
      body { font-family: system-ui, sans-serif; background: #2f3e46; color: #f3f5f4; margin: 0; padding: 20px; }
      h1 { font-size: 1.2rem; }
      pre { white-space: pre-wrap; word-break: break-word; background: rgba(0,0,0,0.25); padding: 12px; border-radius: 10px; font-size: 0.8rem; line-height: 1.5; }
      button { font: inherit; padding: 12px 18px; border-radius: 10px; border: 0; background: #84a98c; color: #1a2824; font-weight: 700; margin-top: 10px; }
    </style>
  </head>
  <body>
    <h1>Kody Video diagnostics</h1>
    <pre id="out">Running…</pre>
    <button id="repair" type="button">Repair &amp; open the app</button>
    <script type="module">
      const out = document.getElementById('out')
      const lines = []
      const log = (line) => { lines.push(line); out.textContent = lines.join('\\n') }

      log('origin: ' + location.origin)
      log('ua: ' + navigator.userAgent)

      // 1. Is the data alive in this origin's IndexedDB? (read-only)
      // Never call indexedDB.open(name) without a version on a missing DB —
      // that creates an empty version-1 database with zero stores. The app
      // then upgrades oldVersion=1 → 2 and only adds 'audio', leaving
      // projects/clips/meta missing (Sentry NotFoundError in getSettings).
      try {
        const db = await openExistingKodyDb()
        if (!db) {
          log('idb: (no database yet on this origin)')
        } else {
          const stores = [...db.objectStoreNames]
          log('idb version: ' + db.version)
          log('idb stores: ' + (stores.join(', ') || '(none)'))
          if (stores.includes('projects')) {
            const tx = db.transaction(stores.filter((s) => ['projects', 'clips'].includes(s)), 'readonly')
            const projects = await new Promise((resolve, reject) => {
              const req = tx.objectStore('projects').getAll()
              req.onsuccess = () => resolve(req.result)
              req.onerror = () => reject(req.error)
            })
            const clipCount = stores.includes('clips')
              ? await new Promise((resolve, reject) => {
                  const req = tx.objectStore('clips').count()
                  req.onsuccess = () => resolve(req.result)
                  req.onerror = () => reject(req.error)
                })
              : 'n/a'
            log('PROJECTS HERE: ' + projects.length + ' (clips: ' + clipCount + ')')
            for (const p of projects.slice(0, 8)) {
              log('  - "' + p.name + '" clips=' + (p.clipIds?.length ?? '?'))
            }
          }
          db.close()
        }
      } catch (err) {
        log('idb: FAILED - ' + err)
      }

      // 2. Shell the HTTP cache serves vs the network's shell.
      const entryOf = (html) => (html.match(/assets\\/index-[A-Za-z0-9_-]+\\.js/) ?? ['(no entry found)'])[0]
      let cachedEntry = '(fetch failed)'
      let networkEntry = '(fetch failed)'
      try { cachedEntry = entryOf(await (await fetch('/', { cache: 'force-cache' })).text()) } catch {}
      try { networkEntry = entryOf(await (await fetch('/', { cache: 'no-store' })).text()) } catch {}
      log('shell entry (http-cache): ' + cachedEntry)
      log('shell entry (network):    ' + networkEntry)
      if (cachedEntry !== networkEntry) log('>>> STALE HTTP CACHE DETECTED <<<')

      // 3. Does the current entry download as real JavaScript?
      try {
        const res = await fetch('/' + networkEntry, { cache: 'no-store' })
        const text = await res.text()
        const looksJs = !/^\\s*<!doctype/i.test(text)
        log('entry fetch: ' + res.status + ' ' + (res.headers.get('content-type') ?? '?') + ' looksLikeJs=' + looksJs)
      } catch (err) {
        log('entry fetch: FAILED - ' + err)
      }

      // 4. Does a fresh copy of the app mount at all? (iframe probe)
      try {
        const frame = document.createElement('iframe')
        frame.style.cssText = 'width:1px;height:1px;opacity:0;position:absolute;'
        frame.src = '/?diag=' + Date.now()
        document.body.append(frame)
        await new Promise((resolve) => setTimeout(resolve, 7000))
        const doc = frame.contentDocument
        const slots = doc ? doc.querySelectorAll('.project-slot').length : -1
        const appChildren = doc ? (doc.getElementById('app')?.children.length ?? -1) : -1
        log('iframe probe: project slots=' + slots + ' app children=' + appChildren)
        frame.remove()
      } catch (err) {
        log('iframe probe: FAILED - ' + err)
      }
      log('--- done. Screenshot this and send it. ---')

      document.getElementById('repair').addEventListener('click', async () => {
        out.textContent = 'Repairing…'
        try {
          const regs = await (navigator.serviceWorker?.getRegistrations?.() ?? [])
          await Promise.all(regs.map((reg) => reg.unregister()))
          const keys = await (self.caches?.keys?.() ?? [])
          await Promise.all(keys.map((key) => caches.delete(key)))
          try {
            sessionStorage.removeItem('kody:boot-entry-reload')
            sessionStorage.removeItem('kody:lazy-chunk-reload')
          } catch {}
          // Re-prime the HTTP cache with fresh copies of the shell + entry.
          const html = await (await fetch('/', { cache: 'reload' })).text()
          const entry = (html.match(/assets\\/index-[A-Za-z0-9_-]+\\.js/) ?? [null])[0]
          if (entry) await fetch('/' + entry, { cache: 'reload' })
        } catch {}
        location.replace('/?fresh=' + Date.now())
      })

      /**
       * Open the app DB only when it already exists. A version-less open on a
       * missing DB would create an empty schema the app cannot heal from
       * without a version bump.
       */
      async function openExistingKodyDb() {
        const name = 'kody-video'
        if (typeof indexedDB.databases === 'function') {
          const listed = await indexedDB.databases()
          if (!listed.some((d) => d.name === name)) return null
        }
        return new Promise((resolve, reject) => {
          const req = indexedDB.open(name)
          req.onupgradeneeded = (event) => {
            // Missing DB: abort the implicit create so we leave nothing behind.
            if (event.oldVersion === 0) event.target.transaction.abort()
          }
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => {
            // Abort of a fresh create surfaces as AbortError — treat as missing.
            if (req.error && req.error.name === 'AbortError') resolve(null)
            else reject(req.error)
          }
          req.onblocked = () => reject(new Error('open blocked by another tab'))
        })
      }
    </script>
  </body>
</html>
`

export async function onRequestGet(): Promise<Response> {
  return new Response(PAGE, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
