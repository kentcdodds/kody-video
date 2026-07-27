// Rear-lens switching probe: Chromium's fake cameras are relabeled as three
// rear cameras so the lens chip renders and can be exercised end to end.
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 4185
const BASE = `http://127.0.0.1:${PORT}`
const preview = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(PORT)], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
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
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
try {
  await waitForServer(BASE)
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream=device-count=3'],
  })
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    permissions: ['camera', 'microphone'],
  })
  await context.addInitScript(() => {
    const original = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
    navigator.mediaDevices.enumerateDevices = async () => {
      const devices = await original()
      return devices.map((device, index) => {
        if (device.kind !== 'videoinput') return device
        return new Proxy(device, {
          get(target, prop) {
            if (prop === 'label') return `camera2 ${index}, facing back`
            const value = Reflect.get(target, prop)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
      })
    }
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (err) => errors.push(String(err)))

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /new project/i }).first().click()
  await page.waitForURL(/\/project\//)
  const ob = page.getByRole('dialog', { name: /quick start/i })
  if (await ob.count()) await page.getByRole('button', { name: /start recording/i }).click()
  const waitForCamera = () =>
    page.waitForFunction(() => {
      const v = document.querySelector('.record-stage video')
      return v && v.videoWidth > 0
    })
  await waitForCamera()
  await sleep(600)

  const lensChip = page.locator('.lens-chip')
  const activeDeviceId = () =>
    page.evaluate(
      () =>
        document.querySelector('.record-stage video')?.srcObject?.getVideoTracks()[0]?.getSettings()
          .deviceId ?? null,
    )

  check('lens chip renders with 3 rear cameras', (await lensChip.count()) === 1)
  check('chip starts at lens 1', (await lensChip.textContent()) === '1/3')

  const firstId = await activeDeviceId()
  await lensChip.click()
  await waitForCamera()
  await sleep(800)
  const secondId = await activeDeviceId()
  check('tap switches to a different camera device', firstId !== secondId)
  check('chip advances to lens 2', (await lensChip.textContent()) === '2/3')

  await page.reload({ waitUntil: 'networkidle' })
  await waitForCamera()
  await sleep(800)
  check('lens choice survives reload', (await lensChip.textContent()) === '2/3')

  await page.locator('button[aria-label="Flip camera"]').click()
  await sleep(1200)
  check('chip hidden while facing user', (await lensChip.count()) === 0)
  await page.locator('button[aria-label="Flip camera"]').click()
  await sleep(1200)
  check('lens choice survives flip roundtrip', (await lensChip.textContent()) === '2/3')

  // Recording still works on the switched lens.
  const box = await page.locator('.record-stage').boundingBox()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
  })
  await sleep(2500)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(1800)
  // UI-level assertion: the editor button is enabled once a clip exists.
  const editorEnabled = await page
    .locator('button[aria-label="Open editor"]')
    .isEnabled()
    .catch(() => false)
  check('recording works on the switched lens', editorEnabled)

  check('no page errors', errors.length === 0, errors.join(' | '))
  await browser.close()
} catch (err) {
  check('probe crashed', false, String(err))
} finally {
  preview.kill()
}
process.exit(results.every(Boolean) ? 0 : 1)
