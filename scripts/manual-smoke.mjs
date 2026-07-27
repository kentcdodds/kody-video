/**
 * Manual UX smoke for Kody Video (no real camera required).
 * Boots vite preview, then walks the core OK Video flow with a fake camera:
 * create project → hold-to-record clips → editor/trim → export → playback.
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 4173
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = process.env.SMOKE_SHOTS_DIR || ''

async function waitForServer(url, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // retry
    }
    await sleep(250)
  }
  throw new Error(`Server not ready: ${url}`)
}

function startPreview() {
  const child = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(PORT)], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return child
}

const results = []
function pass(name, detail = '') {
  results.push({ name, ok: true, detail })
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`)
}
function fail(name, detail = '') {
  results.push({ name, ok: false, detail })
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function shot(page, name) {
  if (!SHOTS) return
  await page.screenshot({ path: `${SHOTS}/${name}.png` }).catch(() => undefined)
}

const preview = startPreview()
try {
  await waitForServer(BASE)

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--deny-permission-prompts',
      '--autoplay-policy=no-user-gesture-required',
    ],
  })
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    permissions: ['camera', 'microphone'],
  })
  const page = await context.newPage()

  const pageErrors = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(msg.text())
  })

  // --- Home: branding + six slots ---
  await page.goto(BASE, { waitUntil: 'networkidle' })
  const title = await page.title()
  const brand = await page.locator('h1.brand').innerText()
  if (title.includes('Kody') && brand.toLowerCase().includes('kody')) {
    pass('home branding', `${title} / ${brand.replace(/\n/g, ' ')}`)
  } else {
    fail('home branding', `${title} / ${brand}`)
  }

  const slotCount = await page.locator('.project-slot').count()
  if (slotCount === 6) pass('six project slots', String(slotCount))
  else fail('six project slots', `found ${slotCount}`)
  await shot(page, '01-home')

  // --- Create + open project ---
  await page.getByRole('button', { name: /new project/i }).first().click()
  await page.waitForURL(/\/project\//, { timeout: 5000 })
  pass('create + open project', page.url())

  // --- Onboarding ---
  const onboarding = page.getByRole('dialog', { name: /quick start/i })
  if (await onboarding.count()) {
    await shot(page, '02-onboarding')
    await page.getByRole('button', { name: /start recording/i }).click()
    pass('onboarding visible and dismissible')
  } else {
    pass('onboarding already dismissed or not shown')
  }

  // --- Record screen ready ---
  const stage = page.locator('.record-stage')
  if (await stage.count()) pass('record stage present')
  else fail('record stage present')

  const cameraReady = await page
    .waitForFunction(
      () => {
        const video = document.querySelector('.record-stage video')
        return video && video.videoWidth > 0
      },
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false)
  if (cameraReady) pass('fake camera preview running')
  else fail('fake camera preview running')
  await shot(page, '03-record')

  // --- Hold-to-record two clips ---
  const stageBox = await stage.boundingBox()
  async function recordClip(ms) {
    await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2)
    await page.mouse.down()
    await sleep(ms)
    await page.mouse.up()
  }

  await recordClip(1300)
  const deleteLastBtn = page.getByRole('button', { name: /delete last clip/i })
  const clipSaved = await page
    .waitForFunction(
      () => {
        const btn = [...document.querySelectorAll('button')].find(
          (b) => b.getAttribute('aria-label') === 'Delete last clip',
        )
        return btn && !btn.disabled
      },
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false)
  if (clipSaved) pass('hold-to-record saves a clip')
  else fail('hold-to-record saves a clip')

  await recordClip(1100)
  await sleep(1500)
  await shot(page, '04-recorded')

  // --- Editor: filmstrip timeline + trim ---
  await page.getByRole('button', { name: /open editor/i }).click()
  const tiles = page.locator('[data-clip-id]')
  const tileCount = await tiles
    .first()
    .waitFor({ timeout: 5000 })
    .then(() => tiles.count())
    .catch(() => 0)
  if (tileCount === 2) pass('editor timeline shows 2 clips', String(tileCount))
  else fail('editor timeline shows 2 clips', `found ${tileCount}`)

  const thumbImgs = await page.locator('.timeline .clip-filmstrip img').count()
  if (thumbImgs > 0) pass('timeline filmstrip thumbnails render', `${thumbImgs} frames`)
  else fail('timeline filmstrip thumbnails render', 'no <img> frames found')
  await shot(page, '05-editor')

  await page.getByRole('button', { name: /^trim$/i }).click()
  const trimStrip = page.getByRole('group', { name: /trim clip/i })
  if (await trimStrip.count()) pass('in-timeline trim mode opens')
  else fail('in-timeline trim mode opens')
  await shot(page, '06-trim')
  await page.getByRole('button', { name: /^cancel$/i }).click()

  // --- Export: OK → full-screen progress overlay → ready with Save ---
  await page.getByRole('button', { name: /^ok$/i }).first().click()
  const overlayShown = await page
    .waitForSelector('.export-overlay', { timeout: 4000 })
    .then(() => true)
    .catch(() => false)
  if (overlayShown) pass('OK opens full-screen export overlay')
  else fail('OK opens full-screen export overlay')

  const previewPainted = await page
    .waitForFunction(
      () => {
        const canvas = document.querySelector('.export-preview-canvas')
        return canvas && canvas.width > 300
      },
      { timeout: 15000 },
    )
    .then(() => true)
    .catch(() => false)
  if (previewPainted) pass('export overlay shows encoded frames')
  else fail('export overlay shows encoded frames')

  const exportDialog = page.getByRole('dialog', { name: /share project/i })

  const exported = await page
    .waitForFunction(
      () => {
        const dialog = document.querySelector('[aria-label="Share project"]')
        if (!dialog) return false
        const text = dialog.textContent || ''
        if (/hit a snag/i.test(text)) return 'error'
        if (/video is ready/i.test(text)) return 'ready'
        return false
      },
      { timeout: 45000 },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => 'timeout')
  if (exported === 'ready') pass('export completes to ready state')
  else fail('export completes to ready state', String(exported))
  await shot(page, '07-export')

  const saveBtn = exportDialog.getByRole('button', { name: /^save$/i })
  if (await saveBtn.count()) pass('export offers Save')
  else fail('export offers Save')

  const upsell = exportDialog.getByRole('button', { name: /remove it — \$0\.99/i })
  if (await upsell.count()) pass('watermark upsell shown while locked')
  else fail('watermark upsell shown while locked')
  await exportDialog.getByRole('button', { name: /done|close/i }).first().click()

  // --- Purchase verification flow (mocked endpoint) + unlocked state ---
  await page.route('**/api/verify-purchase*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ unlocked: true }),
    }),
  )
  await page.goto(`${BASE}/unlocked?session_id=cs_live_smoketest123`, {
    waitUntil: 'networkidle',
  })
  const celebrated = await page
    .waitForSelector('text=/watermark removed/i', { timeout: 5000 })
    .then(() => true)
    .catch(() => false)
  if (celebrated) pass('unlock page verifies and celebrates')
  else fail('unlock page verifies and celebrates')
  await shot(page, '10-unlocked')

  await page.getByRole('link', { name: /start creating/i }).click()
  await page.waitForURL(BASE + '/', { timeout: 5000 }).catch(() => undefined)
  await page.locator('.project-slot.filled .slot-open').first().click()
  await page.waitForURL(/\/project\//, { timeout: 5000 })
  await page.getByRole('button', { name: /^ok$/i }).first().click()
  const unlockedExport = await page
    .waitForFunction(
      () => {
        const dialog = document.querySelector('[aria-label="Share project"]')
        return dialog && /video is ready/i.test(dialog.textContent || '')
      },
      { timeout: 45000 },
    )
    .then(() => true)
    .catch(() => false)
  const upsellGone =
    unlockedExport &&
    (await page.getByRole('button', { name: /remove it — \$0\.99/i }).count()) === 0
  if (upsellGone) pass('purchase removes the watermark upsell')
  else fail('purchase removes the watermark upsell', `exported=${unlockedExport}`)
  await page
    .getByRole('dialog', { name: /share project/i })
    .getByRole('button', { name: /done|close/i })
    .first()
    .click()
  await page.unroute('**/api/verify-purchase*')

  // --- Playback preview overlay ---
  await page.getByRole('button', { name: /play project preview/i }).click()
  const overlay = page.locator('.playback-overlay')
  if (await overlay.count()) pass('playback overlay opens')
  else fail('playback overlay opens')
  const playbackStarted = await page
    .waitForFunction(
      () => {
        const video = document.querySelector('.playback-video')
        return video && video.currentTime > 0
      },
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false)
  if (playbackStarted) pass('playback preview plays')
  else fail('playback preview plays')
  await shot(page, '08-playback')
  await page.getByRole('button', { name: /stop preview/i }).click()

  // --- About page: open-source + OK Video credits ---
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.getByRole('link', { name: /^about$/i }).click()
  await page.waitForURL(/\/about/, { timeout: 5000 })
  await page.waitForSelector('.about-section', { timeout: 5000 }).catch(() => undefined)
  const repoLink = await page
    .locator('a[href="https://github.com/kentcdodds/kody-video"]')
    .count()
  const okVideoLink = await page.locator('a[href="https://okvideo.app"]').count()
  if (repoLink > 0 && okVideoLink > 0) pass('about page links repo and OK Video')
  else fail('about page links repo and OK Video', `repo=${repoLink} okvideo=${okVideoLink}`)
  await shot(page, '11-about')

  // --- Legal pages ---
  await page.goto(`${BASE}/privacy`, { waitUntil: 'networkidle' })
  const privacyOk = await page
    .waitForSelector('text=/location tagging/i', { timeout: 5000 })
    .then(() => true)
    .catch(() => false)
  await page.goto(`${BASE}/terms`, { waitUntil: 'networkidle' })
  const termsOk = await page
    .waitForSelector('text=/as is/i', { timeout: 5000 })
    .then(() => true)
    .catch(() => false)
  if (privacyOk && termsOk) pass('privacy and terms pages render')
  else fail('privacy and terms pages render', `privacy=${privacyOk} terms=${termsOk}`)

  // --- Location toggle present on record screen ---
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('.project-slot.filled .slot-open').first().click()
  await page.waitForURL(/\/project\//, { timeout: 5000 })
  const locToggle = page.getByRole('button', { name: /toggle location tagging/i })
  if ((await locToggle.count()) === 1) pass('location tagging toggle present')
  else fail('location tagging toggle present')

  // --- Persistence / offline / SPA fallback ---
  await page.goto(BASE, { waitUntil: 'networkidle' })
  const filled = await page.locator('.project-slot.filled').count()
  if (filled >= 1) pass('project persists after navigation', `${filled} filled`)
  else fail('project persists after navigation', `${filled} filled`)
  await shot(page, '09-home-filled')

  await page.reload({ waitUntil: 'networkidle' })
  const filledAfterRefresh = await page.locator('.project-slot.filled').count()
  if (filledAfterRefresh >= 1) pass('hard refresh restores projects', `${filledAfterRefresh} filled`)
  else fail('hard refresh restores projects', `${filledAfterRefresh} filled`)

  // --- Project backup round trip (backup → import as new project) ---
  const filledBefore = await page.locator('.project-slot.filled').count()
  await page.getByRole('button', { name: /^options for/i }).first().click()
  const downloadPromise = page.waitForEvent('download', { timeout: 10000 })
  await page.getByRole('button', { name: /save backup/i }).click()
  const download = await downloadPromise.catch(() => null)
  if (download && download.suggestedFilename().endsWith('.kodyvideo')) {
    pass('project backup downloads', download.suggestedFilename())
  } else {
    fail('project backup downloads')
  }
  if (download) {
    const backupPath = await download.path()
    await page.locator('.home-import input[type=file]').setInputFiles(backupPath)
    // Import now lands directly inside the imported project.
    const openedImported = await page
      .waitForURL(/\/project\//, { timeout: 20000 })
      .then(() => true)
      .catch(() => false)
    const importedCameraReady = await page
      .waitForFunction(
        () => {
          const v = document.querySelector('.record-stage video')
          return v && v.videoWidth > 0
        },
        undefined,
        { timeout: 10000 },
      )
      .then(() => true)
      .catch(() => false)
    if (openedImported && importedCameraReady) {
      pass('import navigates into a working imported project')
    } else {
      fail('import navigates into a working imported project', `nav=${openedImported} camera=${importedCameraReady}`)
    }

    await page.goto(BASE, { waitUntil: 'networkidle' })
    const imported = await page
      .waitForFunction(
        (before) => document.querySelectorAll('.project-slot.filled').length > before,
        filledBefore,
        { timeout: 10000 },
      )
      .then(() => true)
      .catch(() => false)
    if (imported) pass('imported project appears on home')
    else fail('imported project appears on home')

    // Poster art must be present already (thumbs generate during import).
    const postersReady = await page
      .waitForFunction(
        () =>
          document.querySelectorAll('.project-slot.filled .slot-poster').length ===
          document.querySelectorAll('.project-slot.filled').length,
        undefined,
        { timeout: 10000 },
      )
      .then(() => true)
      .catch(() => false)
    if (postersReady) pass('imported project shows poster art immediately')
    else fail('imported project shows poster art immediately')
  } else {
    fail('backup imports as a new project', 'no backup file to import')
  }

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await sleep(1000)
  await context.setOffline(true)
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => null)
  const offlineBrand = await page.locator('h1.brand').count()
  if (offlineBrand) pass('offline reload still shows shell')
  else fail('offline reload still shows shell')
  await context.setOffline(false)

  await page.goto(`${BASE}/project/does-not-exist`, { waitUntil: 'networkidle' })
  const backHome = await page.locator('h1.brand').count()
  if (backHome) pass('unknown project redirects home')
  else fail('unknown project redirects home')

  // --- Storage warning (stubbed estimate: 93% full) ---
  const stubbed = await context.newPage()
  await stubbed.addInitScript(() => {
    navigator.storage.estimate = async () => ({
      usage: 9.3 * 1024 ** 3,
      quota: 10 * 1024 ** 3,
    })
  })
  await stubbed.goto(BASE, { waitUntil: 'networkidle' })
  const bannerText = await stubbed
    .locator('.storage-banner.is-critical')
    .innerText()
    .catch(() => '')
  if (/93% full/.test(bannerText) && /delete an old project/i.test(bannerText)) {
    pass('storage warning appears when nearly full')
  } else {
    fail('storage warning appears when nearly full', bannerText.slice(0, 80))
  }
  await shot(stubbed, '12-storage-warning')
  await stubbed.close()

  const realErrors = pageErrors.filter(
    (err) =>
      !/service worker|workbox|manifest|favicon|fonts\.googleapis|fonts\.gstatic|net::ERR_INTERNET_DISCONNECTED/i.test(
        err,
      ),
  )
  if (realErrors.length === 0) pass('no unexpected page errors')
  else fail('no unexpected page errors', realErrors.slice(0, 3).join(' | '))

  await browser.close()
} catch (err) {
  fail('smoke runner', err instanceof Error ? err.message : String(err))
} finally {
  preview.kill('SIGKILL')
}

const failed = results.filter((r) => !r.ok)
console.log('\n--- summary ---')
console.log(`${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
