/**
 * Installed-PWA cold start: after one online visit the shell must paint
 * from the service worker / HTTP cache with the network blocked — never a
 * blank white document. Also checks the production boot script and HTML
 * cache headers that keep iOS standalone off the default white splash.
 *
 * Run: npm run build && node scripts/probe-pwa-offline.mjs
 */
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { preview } from 'vite'

const failures = []
const fail = (message) => {
  failures.push(message)
  console.error(`FAIL ${message}`)
}
const pass = (message) => {
  console.log(`ok   ${message}`)
}

const indexHtml = await readFile('dist/index.html', 'utf8')
const headers = await readFile('dist/_headers', 'utf8')
const sw = await readFile('dist/sw.js', 'utf8')

if (indexHtml.includes('if (standalone) boot()')) {
  pass('production boot script starts immediately when standalone')
} else {
  fail('production boot script starts immediately when standalone')
}

if (indexHtml.includes('if (navigator.onLine === false) return')) {
  pass('production boot recovery refuses to wipe caches while offline')
} else {
  fail('production boot recovery refuses to wipe caches while offline')
}

if (
  indexHtml.includes('fetch("/version.json"') &&
  indexHtml.includes('if (!probe || !probe.ok) return')
) {
  pass('production boot recovery probes the origin before wiping caches')
} else {
  fail('production boot recovery probes the origin before wiping caches')
}

if (indexHtml.includes('background-color: #2f3e46')) {
  pass('shell HTML paints a non-white page color before CSS/JS')
} else {
  fail('shell HTML paints a non-white page color before CSS/JS')
}

if (indexHtml.includes("media=\"not (display-mode: standalone)\"")) {
  pass('LCP image preload is skipped in standalone (does not hold splash)')
} else {
  fail('LCP image preload is skipped in standalone (does not hold splash)')
}

if (
  headers.includes('/index.html') &&
  headers.includes('stale-while-revalidate') &&
  !/\/index\.html\n  Cache-Control:.*must-revalidate/.test(headers)
) {
  pass('HTML Cache-Control allows a stale shell (no must-revalidate)')
} else {
  fail('HTML Cache-Control allows a stale shell (no must-revalidate)')
}

if (headers.includes('/sw.js') && headers.includes('must-revalidate')) {
  pass('sw.js still revalidates so updates can toast')
} else {
  fail('sw.js still revalidates so updates can toast')
}

if (sw.includes('navigateFallback') || sw.includes('/index.html')) {
  pass('generated service worker includes the app-shell fallback')
} else {
  fail('generated service worker includes the app-shell fallback')
}

if (!/navigationPreload.*enabled|enable\(\)/.test(sw) && !sw.includes('navigationPreload.enable')) {
  pass('generated service worker does not enable navigation preload')
} else {
  fail('generated service worker does not enable navigation preload')
}

const server = await preview({ preview: { port: 4184, host: '127.0.0.1' } })
const base = 'http://127.0.0.1:4184'
const browser = await chromium.launch()

async function waitForServiceWorker(page) {
  await page.waitForFunction(
    async () => {
      const regs = await navigator.serviceWorker.getRegistrations()
      return regs.some((reg) => Boolean(reg.active))
    },
    undefined,
    { timeout: 20_000 },
  )
  // Give the worker a beat to claim + finish precache.
  await page.waitForTimeout(500)
}

function shellVisible(page) {
  return page.evaluate(() => {
    const brand = document.querySelector('h1.brand, .home-screen')
    const bodyBg = getComputedStyle(document.body).backgroundColor
    const htmlBg = getComputedStyle(document.documentElement).backgroundColor
    const isWhite = (value) => {
      const rgb = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
      if (!rgb) return false
      return Number(rgb[1]) > 240 && Number(rgb[2]) > 240 && Number(rgb[3]) > 240
    }
    return {
      hasShell: Boolean(brand),
      bodyWhite: isWhite(bodyBg),
      htmlWhite: isWhite(htmlBg),
      bodyBg,
      htmlBg,
    }
  })
}

{
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
  })
  const page = await context.newPage()
  await page.goto(base, { waitUntil: 'networkidle' })
  await waitForServiceWorker(page)
  const online = await shellVisible(page)
  if (online.hasShell && !online.bodyWhite) {
    pass('first visit paints the home shell (not white)')
  } else {
    fail(`first visit paints the home shell (not white) ${JSON.stringify(online)}`)
  }

  await context.setOffline(true)
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => null)
  await page.waitForTimeout(800)
  const offline = await shellVisible(page)
  if (offline.hasShell && !offline.bodyWhite && !offline.htmlWhite) {
    pass('offline reload paints the cached shell (not white)')
  } else {
    fail(`offline reload paints the cached shell (not white) ${JSON.stringify(offline)}`)
  }

  await page.goto(`${base}/about`, { waitUntil: 'domcontentloaded' }).catch(() => null)
  await page.waitForTimeout(800)
  const about = await page.locator('.about-screen').count()
  const aboutBrand = await page.locator('h1.brand').count()
  if (about > 0 || aboutBrand > 0) {
    pass('offline deep link still shows app chrome')
  } else {
    fail('offline deep link still shows app chrome')
  }

  await context.close()
}

{
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
  })
  const page = await context.newPage()
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true })
    const original = window.matchMedia.bind(window)
    window.matchMedia = (query) => {
      const media = original(query)
      if (String(query).includes('display-mode: standalone')) {
        Object.defineProperty(media, 'matches', { configurable: true, value: true })
      }
      return media
    }
  })
  await page.goto(base, { waitUntil: 'networkidle' })
  await waitForServiceWorker(page)
  await context.setOffline(true)
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => null)
  await page.waitForTimeout(800)
  const standalone = await shellVisible(page)
  if (standalone.hasShell && !standalone.bodyWhite) {
    pass('standalone + offline paints the cached shell')
  } else {
    fail(`standalone + offline paints the cached shell ${JSON.stringify(standalone)}`)
  }
  await context.close()
}

{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  await page.goto(base, { waitUntil: 'networkidle' })
  await waitForServiceWorker(page)
  const toastBefore = await page.locator('.update-toast').count()
  await page.evaluate(() => {
    document.querySelector('.app-shell')?.setAttribute('data-probe-keep', '1')
  })
  await context.setOffline(true)
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => null)
  await page.waitForTimeout(500)
  const toastAfter = await page.locator('.update-toast').count()
  const shell = await shellVisible(page)
  if (toastAfter <= toastBefore && shell.hasShell) {
    pass('offline launch does not replace the UI with an update/loading blank')
  } else {
    fail('offline launch does not replace the UI with an update/loading blank')
  }
  await context.close()
}

await browser.close()
await server.close()

if (failures.length > 0) {
  console.error('\nFAIL:\n- ' + failures.join('\n- '))
  process.exit(1)
}
console.log('\npwa offline probe: all checks passed')
