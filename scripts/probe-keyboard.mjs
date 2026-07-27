import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 4183
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
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  })
  // Desktop-shaped context: keyboard flows are a desktop affordance.
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

  check('desktop key hints visible on record screen', await page.locator('.key-hints').first().isVisible())

  // Space hold-to-record: two clips.
  for (let i = 0; i < 2; i++) {
    await page.keyboard.down('Space')
    await sleep(2500)
    await page.keyboard.up('Space')
    await sleep(1200)
  }
  const clipCount = () =>
    page.evaluate(async () => {
      const { getProjects, getClips } = await import('/src/lib/storage.ts')
      const [project] = await getProjects()
      return (await getClips(project.id)).length
    })
  // Preview build: read from UI instead — count via editor after opening.
  await page.keyboard.press('KeyE')
  await page.waitForSelector('.editor-screen')
  const metaText = await page.locator('.editor-meta small').textContent()
  check('space key recorded 2 clips', /2 clips/.test(metaText ?? ''), metaText ?? '')

  // Arrow selection + Alt reorder + duplicate + trim + escape + delete.
  await page.keyboard.press('ArrowLeft')
  await sleep(200)
  const firstSelected = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('.clip-thumb')]
    return tiles.findIndex((t) => t.className.includes('selected') || t.getAttribute('aria-pressed') === 'true')
  })
  check('arrow-left selects previous clip', firstSelected === 0, `selected index ${firstSelected}`)

  await page.keyboard.press('KeyD')
  await sleep(600)
  const afterDup = await page.locator('.editor-meta small').textContent()
  check('D duplicates the clip', /3 clips/.test(afterDup ?? ''), afterDup ?? '')

  await page.keyboard.press('KeyT')
  await sleep(300)
  check('T opens trim strip', (await page.locator('.trim-strip').count()) > 0)
  await page.keyboard.press('Escape')
  await sleep(300)
  check('Escape exits trim', (await page.locator('.trim-strip').count()) === 0)

  await page.keyboard.press('Delete')
  await sleep(600)
  const afterDel = await page.locator('.editor-meta small').textContent()
  check('Delete removes the clip', /2 clips/.test(afterDel ?? ''), afterDel ?? '')

  // P opens playback; Space toggles pause; ArrowRight advances; Escape closes.
  await page.keyboard.press('KeyP')
  await page.waitForSelector('.playback-overlay')
  check('P opens playback overlay', true)
  await sleep(700)
  await page.keyboard.press('Space')
  await sleep(300)
  const paused = await page.evaluate(() => document.querySelector('.playback-video')?.paused)
  check('Space pauses playback', paused === true)
  await page.keyboard.press('Space')
  await sleep(300)
  const resumed = await page.evaluate(() => document.querySelector('.playback-video')?.paused)
  check('Space resumes playback', resumed === false)
  await page.keyboard.press('ArrowRight')
  await sleep(500)
  const caption = await page.locator('.playback-caption').textContent()
  check('ArrowRight advances clip', /Clip 2/.test(caption ?? ''), caption ?? '')
  // While the overlay is open, editor keys must be inert (Delete should not delete).
  await page.keyboard.press('Delete')
  await sleep(400)
  await page.keyboard.press('Escape')
  await sleep(400)
  check('Escape closes playback', (await page.locator('.playback-overlay').count()) === 0)
  const afterOverlayDel = await page.locator('.editor-meta small').textContent()
  check('editor keys inert under overlay', /2 clips/.test(afterOverlayDel ?? ''), afterOverlayDel ?? '')

  // Escape from editor returns to camera.
  await page.keyboard.press('Escape')
  await page.waitForSelector('.record-stage')
  check('Escape returns to camera', true)

  // Quick Space tap-release race: press and release almost immediately.
  await page.keyboard.down('Space')
  await sleep(40)
  await page.keyboard.up('Space')
  await sleep(1500)
  const stuckRecording = await page.evaluate(() => !!document.querySelector('.record-screen.is-recording'))
  check('quick space tap does not leave stuck recording', !stuckRecording)

  check('no page errors', errors.length === 0, errors.join(' | '))
  await browser.close()
} catch (err) {
  check('probe crashed', false, String(err))
} finally {
  preview.kill()
}
process.exit(results.every(Boolean) ? 0 : 1)
