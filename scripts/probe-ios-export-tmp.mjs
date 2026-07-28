// iOS-shaped export repro: build a project backup in Chromium (fake camera),
// import it in WebKit at iPhone dimensions, export, and screenshot the flow.
import { chromium, webkit } from 'playwright'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { mkdirSync } from 'node:fs'

const PORT = 4186
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = '/tmp/ios-export-shots'
mkdirSync(SHOTS, { recursive: true })
const preview = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(PORT)], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
async function waitForServer(url) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await sleep(250)
  }
  throw new Error('server not ready')
}
try {
  await waitForServer(BASE)
  console.log('step: server ready')

  // --- Phase 1: Chromium records two clips and saves a backup file ---
  console.log('step: launching chromium')
  const cr = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  })
  const crPage = await (await cr.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ['camera', 'microphone'],
  })).newPage()
  await crPage.goto(BASE, { waitUntil: 'networkidle' })
  console.log('step: home loaded')
  await crPage.getByRole('button', { name: /new project/i }).first().click()
  await crPage.waitForURL(/\/project\//)
  const ob = crPage.getByRole('dialog', { name: /quick start/i })
  if (await ob.count()) await crPage.getByRole('button', { name: /start recording/i }).click()
  await crPage.waitForFunction(() => {
    const v = document.querySelector('.record-stage video')
    return v && v.videoWidth > 0
  })
  const box = await crPage.locator('.record-stage').boundingBox()
  console.log('step: camera ready, recording')
  for (let i = 0; i < 2; i++) {
    await crPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await crPage.mouse.down()
    await sleep(2500)
    await crPage.mouse.up()
    await sleep(1200)
  }
  // Save a backup through the UI (options sheet → Save backup → download).
  await crPage.goBack({ waitUntil: 'networkidle' }).catch(() => undefined)
  await crPage.goto(BASE, { waitUntil: 'networkidle' })
  console.log('step: opening options sheet')
  await crPage.locator('.project-slot.filled .slot-options').first().click()
  const downloadPromise = crPage.waitForEvent('download', { timeout: 15000 })
  await crPage.getByRole('button', { name: /save backup/i }).click()
  const download = await downloadPromise
  const backupPath = `${SHOTS}/project.kodyvideo`
  await download.saveAs(backupPath)
  await cr.close()
  console.log('backup saved:', backupPath)

  // --- Phase 2: WebKit at iPhone size imports and exports ---
  const wk = await webkit.launch({ headless: true })
  const context = await wk.newContext({
    viewport: { width: 440, height: 956 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (err) => errors.push(String(err)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text().slice(0, 150)}`)
  })
  await page.goto(BASE, { waitUntil: 'networkidle' })
  const importInput = page.locator('input[type="file"]')
  await importInput.setInputFiles(`${SHOTS}/project.kodyvideo`)
  const imported = await page
    .waitForURL(/\/project\//, { timeout: 30000 })
    .then(() => true)
    .catch(() => false)
  if (!imported) {
    await page.screenshot({ path: `${SHOTS}/00-import-failed.png` })
    const banner = await page.locator('.error-banner').textContent().catch(() => null)
    const notice = await page.locator('.home-notice').textContent().catch(() => null)
    console.log('import failed. banner:', banner, 'notice:', notice)
    console.log('errors so far:', errors.slice(0, 6))
    throw new Error('import did not navigate')
  }
  const ob2 = page.getByRole('dialog', { name: /quick start/i })
  if (await ob2.count()) await page.getByRole('button', { name: /start recording/i }).click()
  await sleep(1500)
  await page.screenshot({ path: `${SHOTS}/01-imported.png` })

  await page.getByRole('button', { name: /^go$/i }).first().click()
  const overlayShown = await page
    .waitForSelector('.export-overlay', { timeout: 5000 })
    .then(() => true)
    .catch(() => false)
  console.log('overlay shown:', overlayShown)
  await sleep(1500)
  await page.screenshot({ path: `${SHOTS}/02-exporting-early.png` })
  await sleep(3000)
  await page.screenshot({ path: `${SHOTS}/03-exporting-mid.png` })
  // Wait for completion or error, up to 60s.
  const done = await page
    .waitForSelector('.export-sheet, .sheet, [role="dialog"][aria-label*="xport"]', { timeout: 60000 })
    .then(() => 'done')
    .catch(() => 'timeout')
  console.log('final state:', done)
  await page.screenshot({ path: `${SHOTS}/04-final.png` })
  const overlayStill = await page.locator('.export-overlay').count()
  console.log('overlay still mounted:', overlayStill)
  console.log('errors:', errors.slice(0, 8))
  await wk.close()
} catch (err) {
  console.log('PROBE FAILED:', String(err))
} finally {
  try {
    process.kill(-preview.pid, 'SIGTERM')
  } catch {
    preview.kill()
  }
}
