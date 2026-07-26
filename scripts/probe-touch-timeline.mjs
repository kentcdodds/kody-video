import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 4180
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
  const context = await browser.newContext({
    viewport: { width: 320, height: 700 },
    isMobile: true,
    hasTouch: true,
    permissions: ['camera', 'microphone'],
  })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  const touch = {
    start: (x, y) => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }),
    move: (x, y) => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] }),
    end: () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
  }

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /new project/i }).first().click()
  await page.waitForURL(/\/project\//)
  const ob = page.getByRole('dialog', { name: /quick start/i })
  if (await ob.count()) await page.getByRole('button', { name: /start recording/i }).click()
  await page.waitForFunction(() => {
    const v = document.querySelector('.record-stage video')
    return v && v.videoWidth > 0
  })
  const stage = page.locator('.record-stage')
  const sbox = await stage.boundingBox()
  await page.mouse.move(sbox.x + sbox.width / 2, sbox.y + sbox.height / 2)
  for (let i = 0; i < 4; i++) {
    await page.mouse.down()
    await sleep(3800)
    await page.mouse.up()
    await sleep(1600)
  }
  await page.getByRole('button', { name: /open editor/i }).click()
  await page.locator('[data-clip-id]').first().waitFor()
  await sleep(800)

  const timeline = page.locator('.timeline')
  const overflow = await timeline.evaluate((el) => el.scrollWidth - el.clientWidth)
  check('timeline overflows viewport', overflow > 0, `overflow=${overflow}px`)
  const orderBefore = await page.$$eval('[data-clip-id]', (els) => els.map((e) => e.dataset.clipId))
  const selectedBefore = await page.$$eval('[data-clip-id]', (els) =>
    els.findIndex((e) => e.classList.contains('selected')),
  )

  // 1. TOUCH swipe left = scroll, no lift, no reorder, no selection change.
  const t0 = await page.locator('[data-clip-id]').first().boundingBox()
  const cx = t0.x + t0.width / 2
  const cy = t0.y + t0.height / 2
  let liftedDuringSwipe = false
  await touch.start(cx, cy)
  for (let i = 1; i <= 6; i++) {
    await touch.move(cx - i * 18, cy)
    if (await page.locator('.clip-thumb.lifting').count()) liftedDuringSwipe = true
    await sleep(16)
  }
  const scrollBeforeEnd = await timeline.evaluate((el) => el.scrollLeft)
  await touch.end()
  await sleep(120)
  const scrollAfterFling = await timeline.evaluate((el) => el.scrollLeft)
  await sleep(500)
  const orderAfterSwipe = await page.$$eval('[data-clip-id]', (els) => els.map((e) => e.dataset.clipId))
  const selectedAfterSwipe = await page.$$eval('[data-clip-id]', (els) =>
    els.findIndex((e) => e.classList.contains('selected')),
  )
  check('touch swipe scrolls the strip', scrollBeforeEnd > 10, `scrollLeft=${scrollBeforeEnd}`)
  check('release fling continues the scroll', scrollAfterFling > scrollBeforeEnd, `${scrollBeforeEnd} -> ${scrollAfterFling}`)
  check('touch swipe never lifts a clip', !liftedDuringSwipe)
  check('touch swipe does not reorder', JSON.stringify(orderAfterSwipe) === JSON.stringify(orderBefore))
  check('touch swipe does not change selection', selectedAfterSwipe === selectedBefore, `sel ${selectedBefore} -> ${selectedAfterSwipe}`)

  await timeline.evaluate((el) => {
    el.scrollLeft = 0
  })
  await sleep(200)

  // 2. TOUCH long-press lifts (after 500ms, not before) and drag reorders.
  const tiles = await page.$$('[data-clip-id]')
  const a = await tiles[0].boundingBox()
  const b = await tiles[1].boundingBox()
  await touch.start(a.x + a.width / 2, a.y + a.height / 2)
  await sleep(350)
  const liftedEarly = (await page.locator('.clip-thumb.lifting').count()) > 0
  await sleep(350) // 700ms total
  const lifted = (await page.locator('.clip-thumb.lifting').count()) > 0
  check('no lift at 350ms', !liftedEarly)
  check('touch long-press lifts at 500ms', lifted)
  for (let i = 1; i <= 5; i++) {
    await touch.move(a.x + a.width / 2 + (i * (b.x + b.width * 0.9 - a.x - a.width / 2)) / 5, cy)
    await sleep(20)
  }
  await touch.end()
  await sleep(600)
  const orderAfterDrag = await page.$$eval('[data-clip-id]', (els) => els.map((e) => e.dataset.clipId))
  check(
    'touch long-press drag reorders',
    orderAfterDrag[0] === orderBefore[1] && orderAfterDrag[1] === orderBefore[0],
    `${orderBefore.map((s) => s.slice(-4))} -> ${orderAfterDrag.map((s) => s.slice(-4))}`,
  )

  // 3. TOUCH tap selects.
  const third = await page.locator('[data-clip-id]').nth(2).boundingBox()
  await touch.start(third.x + third.width / 2, third.y + third.height / 2)
  await sleep(80)
  await touch.end()
  await sleep(200)
  const thirdSelected = await page
    .locator('[data-clip-id]')
    .nth(2)
    .evaluate((el) => el.classList.contains('selected'))
  check('touch tap selects a clip', thirdSelected)

  await browser.close()
} finally {
  preview.kill('SIGKILL')
}
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
process.exitCode = results.every(Boolean) ? 0 : 1
