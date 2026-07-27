import { webkit } from 'playwright'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 4184
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
  const browser = await webkit.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (err) => errors.push(String(err)))

  await page.goto(BASE, { waitUntil: 'networkidle' })
  check('home renders in WebKit', (await page.locator('.home-screen').count()) > 0)
  check(
    'iOS experimental note shows',
    await page.locator('.home-ios-note').isVisible().catch(() => false),
  )

  // Feature detection matrix the app's code paths depend on.
  const features = await page.evaluate(() => ({
    getUserMedia: !!navigator.mediaDevices?.getUserMedia,
    mediaRecorder: typeof MediaRecorder !== 'undefined',
    mr_mp4: typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/mp4'),
    mr_webm:
      typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus'),
    videoEncoder: typeof VideoEncoder !== 'undefined',
    audioEncoder: typeof AudioEncoder !== 'undefined',
    audioContext: typeof AudioContext !== 'undefined',
    rvfc: 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
    wakeLock: 'wakeLock' in navigator,
    vibrate: 'vibrate' in navigator,
    storageEstimate: !!navigator.storage?.estimate,
    persist: !!navigator.storage?.persist,
    canShareFiles: (() => {
      try {
        const f = new File([new Blob(['x'])], 'x.mp4', { type: 'video/mp4' })
        return !!navigator.canShare?.({ files: [f] })
      } catch {
        return false
      }
    })(),
    idb: typeof indexedDB !== 'undefined',
    webmPlayback: document.createElement('video').canPlayType('video/webm; codecs="vp9"'),
    mp4Playback: document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"'),
    geolocation: 'geolocation' in navigator,
    pointerEvents: typeof PointerEvent !== 'undefined',
  }))
  console.log('FEATURES', JSON.stringify(features, null, 2))

  // Navigation and static pages.
  await page.goto(`${BASE}/about`, { waitUntil: 'networkidle' })
  check('about page renders', (await page.locator('.about-section').count()) >= 5)
  await page.goto(`${BASE}/privacy`, { waitUntil: 'networkidle' })
  check('privacy renders', (await page.locator('.about-body, .legal-body, main').count()) > 0)

  // New project + onboarding + record screen shell (camera will fail: no device).
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /new project/i }).first().click()
  await page.waitForURL(/\/project\//)
  const ob = page.getByRole('dialog', { name: /quick start/i })
  if (await ob.count()) await page.getByRole('button', { name: /start recording/i }).click()
  await sleep(2500)
  const shell = await page.evaluate(() => ({
    stage: !!document.querySelector('.record-stage'),
    errorText: document.querySelector('.camera-error, .record-error')?.textContent ?? null,
    bodyText: document.body.innerText.slice(0, 400),
  }))
  check('record screen shell renders (no camera hardware here)', shell.stage, shell.errorText ?? '')

  check('no unexpected page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  await browser.close()
} catch (err) {
  check('probe crashed', false, String(err))
} finally {
  preview.kill()
}
process.exit(results.every(Boolean) ? 0 : 1)
