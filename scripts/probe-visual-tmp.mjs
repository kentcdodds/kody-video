import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 4176
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
try {
  await waitForServer(BASE)
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  })

  // Light mode, mobile
  const light = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    permissions: ['camera', 'microphone'],
    colorScheme: 'light',
  })
  const lp = await light.newPage()
  await lp.goto(BASE, { waitUntil: 'networkidle' })
  await lp.screenshot({ path: '/tmp/smoke-shots/v1-home-light.png' })
  await lp.getByRole('button', { name: /new project/i }).first().click()
  await lp.waitForURL(/\/project\//)
  const ob = lp.getByRole('dialog', { name: /quick start/i })
  if (await ob.count()) {
    await lp.screenshot({ path: '/tmp/smoke-shots/v2-onboarding-light.png' })
    await lp.getByRole('button', { name: /start recording/i }).click()
  }
  await sleep(1500)
  await lp.screenshot({ path: '/tmp/smoke-shots/v3-record-light.png' })
  await light.close()

  // Desktop dark
  const desktop = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ['camera', 'microphone'],
    colorScheme: 'dark',
  })
  const dp = await desktop.newPage()
  await dp.goto(BASE, { waitUntil: 'networkidle' })
  await dp.screenshot({ path: '/tmp/smoke-shots/v4-home-desktop.png' })
  await desktop.close()

  // Small phone (360x640)
  const small = await browser.newContext({
    viewport: { width: 360, height: 640 },
    isMobile: true,
    hasTouch: true,
    permissions: ['camera', 'microphone'],
  })
  const sp = await small.newPage()
  await sp.goto(BASE, { waitUntil: 'networkidle' })
  await sp.screenshot({ path: '/tmp/smoke-shots/v5-home-small.png' })
  await small.close()

  await browser.close()
  console.log('visual probe done')
} finally {
  preview.kill('SIGKILL')
}
