/**
 * Verifies the iOS Share → Add to Home Screen hint: shows for iPhone Safari
 * UAs, dismisses permanently, and stays hidden for Android/standalone.
 * Run: node scripts/probe-install-hint.mjs (needs `npm run build` first)
 */
import { chromium } from 'playwright'
import { preview } from 'vite'

const IOS_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const IOS_WEBVIEW_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36'

const server = await preview({ preview: { port: 4183 } })
const base = 'http://localhost:4183'
const browser = await chromium.launch()
const failures = []

async function hintVisible(ua, setup) {
  const context = await browser.newContext({ userAgent: ua, viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  await page.goto(base)
  if (setup) await setup(page)
  const visible = await page
    .locator('.home-install-hint')
    .isVisible()
    .catch(() => false)
  await context.close()
  return visible
}

if (!(await hintVisible(IOS_SAFARI_UA))) failures.push('iOS Safari should show the hint')
if (await hintVisible(ANDROID_UA)) failures.push('Android should not show the hint')
if (await hintVisible(IOS_WEBVIEW_UA)) failures.push('iOS bare WebView should not show the hint')

{
  const context = await browser.newContext({
    userAgent: IOS_SAFARI_UA,
    viewport: { width: 390, height: 844 },
  })
  const page = await context.newPage()
  await page.goto(base)
  await page.click('.install-hint-dismiss')
  if (await page.locator('.home-install-hint').isVisible().catch(() => false)) {
    failures.push('dismiss should hide the hint immediately')
  }
  await page.reload()
  if (await page.locator('.home-install-hint').isVisible().catch(() => false)) {
    failures.push('dismissal should persist across reloads')
  }
  await context.close()
}

await browser.close()
await server.close()

if (failures.length > 0) {
  console.error('FAIL:\n- ' + failures.join('\n- '))
  process.exit(1)
}
console.log('install hint probe: all checks passed')
