/**
 * Smoke test against the deployed remix.kody.video preview: boot, create a
 * project by hold-to-record with the fake camera, verify the clip landed on
 * the filmstrip, open the editor, and play back.
 *
 * Usage: node scripts/probe-deployed-remix.mjs [origin]
 */
import { chromium } from 'playwright'

const origin = process.argv[2] ?? 'https://remix.kody.video'

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
})

const fail = (message) => {
  console.error(`FAIL: ${message}`)
  process.exitCode = 1
}

try {
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 },
    permissions: ['camera', 'microphone'],
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))

  await page.goto(origin, { waitUntil: 'networkidle' })

  // Home renders with the brand + a New project slot.
  await page.waitForSelector('.home-screen', { timeout: 15000 })
  console.log('home screen rendered')

  await page.click('.project-slot.empty')
  await page.waitForSelector('.record-screen', { timeout: 15000 })
  // Dismiss onboarding if it appears.
  const onboarding = page.locator('.onboarding-overlay button')
  if (await onboarding.count()) {
    await onboarding.click()
  }
  await page.waitForSelector('.camera-video', { timeout: 15000 })
  await page.waitForFunction(
    () => document.querySelector('.camera-video')?.readyState >= 2,
    undefined,
    { timeout: 15000 },
  )
  console.log('camera preview live')

  // Hold to record ~1.4s.
  const stage = page.locator('.record-stage')
  const box = await stage.boundingBox()
  if (!box) throw new Error('record stage has no bounding box')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForSelector('.record-pill', { timeout: 5000 })
  await page.waitForTimeout(1400)
  await page.mouse.up()

  // The lazy project persists and the URL leaves /project/new.
  await page.waitForFunction(() => !location.pathname.endsWith('/new'), undefined, {
    timeout: 15000,
  })
  console.log(`project created at ${await page.evaluate(() => location.pathname)}`)

  // Open editor, expect one clip on the timeline.
  await page.click('[aria-label="Open editor"]')
  await page.waitForSelector('.editor-screen', { timeout: 10000 })
  const clipCount = await page.locator('.clip-thumb').count()
  if (clipCount !== 1) fail(`expected 1 clip on the timeline, saw ${clipCount}`)
  else console.log('clip landed on the filmstrip')

  // Playback overlay runs.
  await page.click('[aria-label="Play project preview"]')
  await page.waitForSelector('.playback-overlay', { timeout: 10000 })
  console.log('playback overlay opened')
  await page.click('.playback-tap-zones button[aria-label="Stop preview"]')

  // Purchase verification function responds (server-side function reachable).
  const verify = await page.evaluate(async () => {
    const response = await fetch('/api/verify-purchase?session_id=cs_test_bogus')
    return { status: response.status, body: await response.text() }
  })
  console.log(`verify-purchase: ${verify.status} ${verify.body.slice(0, 120)}`)

  if (errors.length > 0) fail(`page errors: ${errors.join(' | ')}`)
  else console.log('no page errors')
} catch (error) {
  fail(String(error))
} finally {
  await browser.close()
}

console.log(process.exitCode ? 'SMOKE FAILED' : 'SMOKE PASSED')
