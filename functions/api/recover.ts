/**
 * Cloudflare Pages Function: a self-service recovery page for clients stuck
 * on a stale app shell. A service worker holding a retired precached shell
 * keeps serving it for every navigation — and since the broken shell's
 * JavaScript never boots, the app can never accept the waiting update, so
 * the state persists across relaunches.
 *
 * Navigations under /api/ are on the service worker's navigateFallback
 * denylist (see vite.config.ts), so this page always arrives fresh from the
 * network, even for fully wedged clients. Its inline script drops the
 * origin's service worker registrations and Cache Storage — never IndexedDB,
 * so projects and clips are untouched — then returns to the app.
 */

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Kody Video — repair</title>
    <style>
      body { font-family: system-ui, sans-serif; background: #2f3e46; color: #f3f5f4;
             display: grid; place-items: center; min-height: 100vh; margin: 0; text-align: center; }
      main { padding: 24px; max-width: 26rem; }
      h1 { font-size: 1.3rem; }
      p { line-height: 1.5; opacity: 0.9; }
    </style>
  </head>
  <body>
    <main>
      <h1>Repairing Kody Video…</h1>
      <p id="status">Removing the stuck service worker and cached app files. Your projects and clips are not touched.</p>
    </main>
    <script type="module">
      const status = document.getElementById('status')
      try {
        const regs = await (navigator.serviceWorker?.getRegistrations?.() ?? [])
        await Promise.all(regs.map((reg) => reg.unregister()))
        const keys = await (self.caches?.keys?.() ?? [])
        await Promise.all(keys.map((key) => caches.delete(key)))
        try {
          sessionStorage.removeItem('kody:boot-recover-at')
          sessionStorage.removeItem('kody:lazy-chunk-reload')
        } catch {}
        // Re-prime the HTTP cache across the app's whole asset graph:
        // cache:'reload' replaces any poisoned entries (SPA-fallback HTML
        // cached under hashed .js/.css URLs during a deploy window).
        status.textContent = 'Refreshing the app files…'
        const seen = new Set()
        const queue = ['/']
        while (queue.length && seen.size < 40) {
          const url = queue.shift()
          if (seen.has(url)) continue
          seen.add(url)
          try {
            const res = await fetch(url, { cache: 'reload' })
            const type = res.headers.get('content-type') ?? ''
            if (/javascript|html/.test(type)) {
              const text = await res.text()
              for (const match of text.matchAll(/assets\\/[A-Za-z0-9_.-]+\\.(?:js|css|woff2)/g)) {
                queue.push('/' + match[0])
              }
            }
          } catch {}
        }
        status.textContent = 'Done - taking you back to the app...'
        setTimeout(() => location.replace('/'), 900)
      } catch (err) {
        status.textContent = 'Could not finish automatically: ' + err + ' - close every Kody Video tab and app window, then open kody.video again.'
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
