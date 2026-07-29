/**
 * Screen recording probe (desktop Chromium): the monitor button captures the
 * tab via getDisplayMedia and appends the take as a regular clip.
 * Run: npm run build && node scripts/probe-screen-record.mjs
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 4187
const BASE = `http://127.0.0.1:${PORT}`
const preview = spawn(
  'npm',
  ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(PORT)],
  { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
)
async function waitForServer(url) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await sleep(250)
  }
  throw new Error('server not ready')
}
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
try {
  await waitForServer(BASE)
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      // Answers the getDisplayMedia picker without UI.
      '--auto-select-desktop-capture-source=Entire screen',
    ],
  })
  const context = await browser.newContext({
    viewport: { width: 1200, height: 900 },
    permissions: ['camera', 'microphone'],
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (err) => errors.push(String(err)))

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /new project/i }).first().click()
  await page.waitForURL(/\/project\//)
  const ob = page.getByRole('dialog', { name: /quick start/i })
  if (await ob.count()) await page.getByRole('button', { name: /start recording/i }).click()
  await page.waitForFunction(() => {
    const v = document.querySelector('.record-stage video')
    return v && v.videoWidth > 0
  })

  const recordButton = page.getByRole('button', { name: /record your screen/i })
  check('screen record button visible on desktop', await recordButton.isVisible())
  check('key hints mention S screen', /S.*screen/i.test(await page.locator('.key-hints').innerText()))

  await recordButton.click()
  await page.waitForSelector('.record-pill', { timeout: 5000 })
  check(
    'screen take pill shows',
    /SCREEN — TAP TO STOP/.test(await page.locator('.record-pill').innerText()),
  )
  check('Go blocked during screen take', await page.locator('.go-button').isDisabled())

  await sleep(2500)
  // The stage doubles as the stop button during a screen take.
  await page.locator('.record-stage').click()
  await page.waitForSelector('.toast', { timeout: 8000 })
  const toast = await page.locator('.toast').innerText()
  check('stop saves the clip', /Screen clip added/i.test(toast), toast)

  // Let the loader revalidation land before reading the clip list.
  await sleep(1500)
  await page.keyboard.press('KeyE')
  await page.waitForSelector('.editor-screen')
  const metaText = await page.locator('.editor-meta small').textContent()
  check('screen take appears as a clip', /1 clip\b/.test(metaText ?? ''), metaText ?? '')

  check('no page errors', errors.length === 0, errors.join(' | '))
  await browser.close()
} catch (err) {
  check('probe crashed', false, String(err))
} finally {
  preview.kill()
}
process.exit(results.every(Boolean) ? 0 : 1)
