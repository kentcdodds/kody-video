import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 4196
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
  const ob = page.getByRole('dialog', { name: /quick start/i })
  if (await ob.count()) await page.getByRole('button', { name: /start recording/i }).click()
  await page.waitForFunction(() => {
    const v = document.querySelector('.record-stage video')
    return v && v.videoWidth > 0
  })
  const stage = await page.locator('.record-stage').boundingBox()
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2)
  await page.mouse.down()
  await sleep(1500)
  await page.mouse.up()
  await sleep(2500) // thumbs backfill on revalidation

  const result = await page.evaluate(async () => {
    const dbs = await indexedDB.databases()
    void dbs
    const open = indexedDB.open('kody-video')
    const db = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    const clips = await new Promise((resolve, reject) => {
      const tx = db.transaction('clips')
      const req = tx.objectStore('clips').getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const clip = clips[0]
    if (!clip) return { error: 'no clips' }
    const measure = async (blob) => {
      if (!blob) return null
      const img = new Image()
      img.src = URL.createObjectURL(blob)
      await img.decode()
      return { w: img.naturalWidth, h: img.naturalHeight, bytes: blob.size }
    }
    return {
      poster: await measure(clip.poster),
      thumb: await measure(clip.thumbs?.[0]),
    }
  })
  console.log(JSON.stringify(result, null, 2))
  await browser.close()
} finally {
  preview.kill('SIGKILL')
}
