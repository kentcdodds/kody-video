import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 4174
const BASE = `http://127.0.0.1:${PORT}`

const preview = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(PORT)], {
  cwd: '/workspace',
  stdio: ['ignore', 'pipe', 'pipe'],
})

async function waitForServer(url) {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {}
    await sleep(250)
  }
  throw new Error('server not ready')
}

try {
  await waitForServer(BASE)
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
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
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /new project/i }).first().click()
  await page.waitForURL(/\/project\//)
  const onboarding = page.getByRole('dialog', { name: /quick start/i })
  if (await onboarding.count()) await page.getByRole('button', { name: /start recording/i }).click()
  await page.waitForFunction(() => {
    const v = document.querySelector('.record-stage video')
    return v && v.videoWidth > 0
  })
  const stage = page.locator('.record-stage')
  const box = await stage.boundingBox()
  // record one clip while capturing mid-recording shot
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await sleep(700)
  await page.screenshot({ path: '/tmp/smoke-shots/p1-recording.png' })
  await sleep(800)
  await page.mouse.up()
  await sleep(1600)
  // second clip
  await page.mouse.down()
  await sleep(1000)
  await page.mouse.up()
  await sleep(1600)

  await page.getByRole('button', { name: /open editor/i }).click()
  await page.locator('[data-clip-id]').first().waitFor()
  await sleep(600)
  await page.getByRole('button', { name: /^trim$/i }).click()
  await sleep(700)
  await page.screenshot({ path: '/tmp/smoke-shots/p2-trim-settled.png' })
  await page.getByRole('button', { name: /^cancel$/i }).click()

  await page.getByRole('button', { name: /play project preview/i }).click()
  await sleep(1000)
  await page.screenshot({ path: '/tmp/smoke-shots/p3-playback-settled.png' })
  await page.getByRole('button', { name: /stop preview/i }).click()
  await browser.close()
  console.log('probe done')
} finally {
  preview.kill('SIGKILL')
}
