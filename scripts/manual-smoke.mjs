/**
 * Manual UX smoke for Kody Video (no real camera required).
 * Boots preview server expectations against a running origin, or starts vite preview.
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 4173
const BASE = `http://127.0.0.1:${PORT}`

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

const preview = startPreview()
try {
  await waitForServer(BASE)

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--deny-permission-prompts',
    ],
  })
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    permissions: ['camera', 'microphone'],
  })
  const page = await context.newPage()

  // Home branding + 6 slots
  await page.goto(BASE, { waitUntil: 'networkidle' })
  const title = await page.title()
  const brand = await page.locator('h1.brand').innerText()
  if (title.includes('Kody') && brand.toLowerCase().includes('kody')) {
    pass('home branding', `${title} / ${brand.replace(/\n/g, ' ')}`)
  } else {
    fail('home branding', `${title} / ${brand}`)
  }

  const slots = page.locator('.project-slots .project-slot, .project-slots article, .project-slots button, .project-slots a')
  // Count slot containers more reliably
  const slotCount = await page.locator('.project-slot').count()
  if (slotCount === 6) pass('six project slots', String(slotCount))
  else fail('six project slots', `found ${slotCount}`)

  // Create project
  const emptyCreate = page.getByRole('button', { name: /new project|create|empty|tap to create|start/i }).first()
  if (await emptyCreate.count()) {
    await emptyCreate.click()
  } else {
    // click first empty slot button
    await page.locator('.project-slot.empty, .project-slot:not(.filled)').first().click()
  }
  await page.waitForURL(/\/project\//, { timeout: 5000 })
  pass('create + open project', page.url())

  // Onboarding may show
  const onboarding = page.getByRole('dialog', { name: /quick start/i })
  if (await onboarding.count()) {
    await page.getByRole('button', { name: /start recording/i }).click()
    pass('onboarding visible and dismissible')
  } else {
    pass('onboarding already dismissed or not shown')
  }

  // Camera stage exists for hold-to-record
  const stage = page.locator('.camera-stage')
  if (await stage.count()) pass('camera stage present')
  else fail('camera stage present')

  // Self-timer control
  const timer = page.getByRole('button', { name: /timer|self[- ]?timer/i })
  if (await timer.count()) pass('self-timer control present')
  else fail('self-timer control present')

  // Editor mode
  const editorBtn = page.getByRole('button', { name: /^editor$/i }).first()
  if (await editorBtn.count()) {
    await editorBtn.click()
    const okBtn = page.getByRole('button', { name: /^ok$/i }).first()
    const trimBtn = page.getByRole('button', { name: /^trim$/i }).first()
    const deleteBtn = page.getByRole('button', { name: /^delete$/i }).first()
    if (await okBtn.count()) pass('editor mode + OK CTA')
    else fail('editor mode + OK CTA', 'OK button missing')

    // On short mobile viewports, editor actions must remain reachable via scroll.
    await page.setViewportSize({ width: 390, height: 640 })
    const screen = page.locator('.camera-screen')
    const before = await screen.evaluate((el) => el.scrollTop)
    await screen.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    const after = await screen.evaluate((el) => el.scrollTop)
    const deleteBox = await deleteBtn.boundingBox()
    const trimVisible = await trimBtn.isVisible()
    if (trimVisible && (after >= before || (deleteBox && deleteBox.y > 0))) {
      pass('editor scroll reaches actions', `scroll ${before}->${after}`)
    } else {
      fail('editor scroll reaches actions', `scroll ${before}->${after}, trim=${trimVisible}`)
    }
    await page.setViewportSize({ width: 390, height: 844 })
  } else {
    fail('editor mode toggle')
  }

  // Back home, persistence after reload via IndexedDB create
  await page.goto(BASE, { waitUntil: 'networkidle' })
  const filled = await page.locator('.project-slot.filled').count()
  if (filled >= 1) pass('project persists after navigation', `${filled} filled`)
  else fail('project persists after navigation', `${filled} filled`)

  await page.reload({ waitUntil: 'networkidle' })
  const filledAfterRefresh = await page.locator('.project-slot.filled').count()
  if (filledAfterRefresh >= 1) pass('hard refresh restores projects', `${filledAfterRefresh} filled`)
  else fail('hard refresh restores projects', `${filledAfterRefresh} filled`)

  // Offline shell: service worker may need a second load in preview
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await sleep(1000)
  await context.setOffline(true)
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => null)
  const offlineBrand = await page.locator('h1.brand').count()
  if (offlineBrand) pass('offline reload still shows shell')
  else fail('offline reload still shows shell')
  await context.setOffline(false)

  // SPA deep link fallback
  await page.goto(`${BASE}/project/does-not-exist`, { waitUntil: 'networkidle' })
  const notFoundish = await page.locator('text=/not found|missing|back home/i').count()
  if (notFoundish) pass('SPA route fallback works')
  else fail('SPA route fallback works')

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
