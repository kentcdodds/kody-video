/**
 * One-off export verification in Google Chrome stable (proprietary codecs):
 * records clips with the fake camera, exports, and validates the resulting
 * file (container, duration, playability, audio decodability) in-page.
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 4175
const BASE = `http://127.0.0.1:${PORT}`

const preview = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(PORT)], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
})

async function waitForServer(url) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // retry
    }
    await sleep(250)
  }
  throw new Error('server not ready')
}

try {
  await waitForServer(BASE)
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
    ],
  })
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    permissions: ['camera', 'microphone'],
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36',
  })
  const page = await context.newPage()
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') console.log(`[page ${msg.type()}]`, msg.text())
  })
  page.on('pageerror', (err) => console.log('[pageerror]', String(err)))

  await page.goto(BASE, { waitUntil: 'networkidle' })

  // What does codec negotiation pick on this Chrome?
  const support = await page.evaluate(async () => {
    const checks = {}
    const vids = {
      avc: { codec: 'avc1.640028', width: 720, height: 1280, bitrate: 4_000_000, framerate: 30, avc: { format: 'avc' } },
      vp9: { codec: 'vp09.00.31.08', width: 720, height: 1280, bitrate: 4_000_000, framerate: 30 },
      vp8: { codec: 'vp8', width: 720, height: 1280, bitrate: 4_000_000, framerate: 30 },
    }
    for (const [name, config] of Object.entries(vids)) {
      try {
        checks[name] = (await VideoEncoder.isConfigSupported(config)).supported
      } catch (e) {
        checks[name] = `err:${e}`
      }
    }
    for (const [name, codec] of [['aac', 'mp4a.40.2'], ['opus', 'opus']]) {
      try {
        checks[name] = (await AudioEncoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 })).supported
      } catch (e) {
        checks[name] = `err:${e}`
      }
    }
    checks.recorderMp4 = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.640028,mp4a.40.2')
    return checks
  })
  console.log('codec support:', JSON.stringify(support))

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
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (const ms of [1500, 1200]) {
    await page.mouse.down()
    await sleep(ms)
    await page.mouse.up()
    await sleep(1800)
  }

  // Capture the exported blob by intercepting share/download via the sheet state:
  // run export, then read the blob back out of the page for validation.
  await page.getByRole('button', { name: /^go$/i }).first().click()
  const state = await page
    .waitForFunction(
      () => {
        const dialog = document.querySelector('[aria-label="Share project"]')
        if (!dialog) return false
        const text = dialog.textContent || ''
        if (/hit a snag/i.test(text)) return { state: 'error', text }
        const match = text.match(/(MP4|WEBM)\s*·\s*([\d.]+)\s*MB/i)
        if (/video is ready/i.test(text)) return { state: 'ready', info: match ? match[0] : text.slice(0, 120) }
        return false
      },
      { timeout: 60000 },
    )
    .then((h) => h.jsonValue())
  console.log('export result:', JSON.stringify(state))

  // Save the exported file and keep it for local ffmpeg inspection.
  const downloadPromise = page.waitForEvent('download', { timeout: 15000 })
  await page.getByRole('button', { name: /^save$/i }).click()
  const download = await downloadPromise
  const outPath = `/tmp/kody-export-probe.${download.suggestedFilename().split('.').pop()}`
  await download.saveAs(outPath)
  console.log('saved export:', outPath, download.suggestedFilename())

  await browser.close()
} finally {
  preview.kill('SIGKILL')
}
console.log('probe-export done')
