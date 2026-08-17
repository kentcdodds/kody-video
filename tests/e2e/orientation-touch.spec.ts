import { test, expect, type Page } from '@playwright/test'
import {
  gotoHome,
  openNewProject,
  recordClip,
  totalClipCount,
  unlockPlus,
  waitForCameraReady,
} from './helpers'

// Runs under the `touch` Playwright project (real touch emulation, so
// `pointer: coarse` matches): the rotate-to-choose flow only exists on
// devices that are physically held.

async function shellLayout(page: Page) {
  return page.evaluate(() => document.documentElement.dataset.shell)
}

async function rotate(page: Page) {
  const viewport = page.viewportSize()!
  await page.setViewportSize({ width: viewport.height, height: viewport.width })
}

async function storedOrientation(page: Page) {
  return page.evaluate(async () => {
    const storage = await import('/src/lib/storage.ts')
    return (await storage.listProjects())[0]?.orientation as string | undefined
  })
}

test.describe('rotate-to-choose orientation (touch)', () => {
  test('sanity: the touch project emulates a coarse pointer', async ({ page }) => {
    await page.goto('/')
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
  })

  test('plus: an empty project follows rotation and the first take locks it', async ({
    page,
  }) => {
    await page.goto('/')
    await unlockPlus(page)
    await openNewProject(page)

    // Upright: portrait interface, nothing stored yet.
    await expect.poll(() => shellLayout(page)).toBe('narrow')

    // Turn the phone: the interface follows (no upsell — Plus).
    await rotate(page)
    await expect.poll(() => shellLayout(page)).toBe('wide')
    await expect(page.locator('.project-screen.orientation-landscape')).toBeVisible()
    await expect(page.locator('.sheet[aria-label="Kody Video Plus"]')).toBeHidden()

    // On a held device the app is FULL-BLEED — no desktop frame margins
    // shrinking the camera, even though a sideways phone is ≥720px wide.
    const viewport = page.viewportSize()!
    const root = await page.locator('#root').boundingBox()
    expect(root!.x).toBe(0)
    expect(root!.width).toBe(viewport.width)

    // Every rail control is reachable: within the viewport on a normal
    // landscape phone height…
    for (const control of await page.locator('.record-dock button').all()) {
      const box = await control.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.y).toBeGreaterThanOrEqual(0)
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1)
    }
    // …and via rail scrolling on a very short one (a centered column would
    // clip both ends unreachably).
    await page.setViewportSize({ width: viewport.width, height: 300 })
    const dock = page.locator('.record-dock')
    expect(await dock.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    await dock.evaluate((el) => el.scrollTo(0, el.scrollHeight))
    const go = await page.locator('.record-dock .go-button').boundingBox()
    expect(go!.y + go!.height).toBeLessThanOrEqual(301)
    await page.setViewportSize({ width: viewport.width, height: viewport.height })

    // The first take decides: recording sideways locks the project landscape.
    await recordClip(page)
    await expect.poll(() => storedOrientation(page)).toBe('landscape')
    await expect(page.locator('.project-screen')).toHaveClass(/is-film-framed/)
    const landscapeFilm = await page.locator('.record-stage > .film-frame').boundingBox()
    expect(landscapeFilm).not.toBeNull()
    expect(landscapeFilm!.width / landscapeFilm!.height).toBeCloseTo(16 / 9, 2)

    // From now on the interface is stuck landscape — turning the phone back
    // upright keeps the landscape layout and asks for a turn instead.
    await rotate(page)
    await expect.poll(() => shellLayout(page)).toBe('wide')
    await expect(page.locator('.orientation-hint')).toBeVisible()
    await expect(page.locator('.orientation-hint')).toContainText(/turn your device sideways/i)

    // Survives a reload.
    await page.reload()
    await page.locator('.camera-video').waitFor()
    await expect.poll(() => shellLayout(page)).toBe('wide')
  })

  test('free plan: rotating previews landscape but the take is gated behind Plus', async ({
    page,
  }) => {
    await openNewProject(page)
    await expect.poll(() => shellLayout(page)).toBe('narrow')

    // Turn the phone: the layout shifts (the preview IS the pitch) and the
    // upsell opens to explain the gate.
    await rotate(page)
    await expect.poll(() => shellLayout(page)).toBe('wide')
    const upsell = page.locator('.sheet[aria-label="Kody Video Plus"]')
    await expect(upsell).toBeVisible()
    await expect(upsell).toContainText(/landscape projects/i)
    await upsell.getByRole('button', { name: 'Not now' }).click()
    await expect(upsell).toBeHidden()

    // The standing gate pill explains why recording waits; pressing the
    // stage re-opens the upsell instead of starting a take.
    await expect(page.locator('.orientation-gate-pill')).toBeVisible()
    const stage = await page.locator('.record-stage').boundingBox()
    await page.mouse.move(stage!.x + stage!.width / 2, stage!.y + stage!.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(800)
    await page.mouse.up()
    await expect(upsell).toBeVisible()
    expect(await totalClipCount(page)).toBe(0)
    await upsell.getByRole('button', { name: 'Not now' }).click()

    // Turning back upright: everything works free, and the first take locks
    // portrait (stored as nothing — the default).
    await rotate(page)
    await expect.poll(() => shellLayout(page)).toBe('narrow')
    await expect(page.locator('.orientation-gate-pill')).toBeHidden()
    await recordClip(page)
    expect(await storedOrientation(page)).toBeUndefined()
    await expect(page.locator('.project-screen')).toHaveClass(/is-film-framed/)
    const film = page.locator('.record-stage > .film-frame')
    const box = await film.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width / box!.height).toBeCloseTo(9 / 16, 2)
    expect(
      await page.evaluate(async () => {
        const storage = await import('/src/lib/storage.ts')
        return (await storage.listProjects()).length
      }),
    ).toBe(1)
  })
})

test.describe('export-cover preview (touch)', () => {
  test('camera, editor, and playback show the film-shaped cover crop', async ({
    page,
  }, testInfo) => {
    const shot = async (name: string) => {
      const file = testInfo.outputPath(`${name}.png`)
      await page.screenshot({ path: file, fullPage: false })
      await page.screenshot({ path: `/opt/cursor/artifacts/${name}.png`, fullPage: false })
    }

    await openNewProject(page)
    await recordClip(page)
    await waitForCameraReady(page)
    await expect(page.locator('.project-screen')).toHaveClass(/is-film-framed/)
    await shot('camera_portrait_locked')

    await rotate(page)
    await expect(page.locator('.orientation-hint')).toBeVisible()
    await shot('camera_held_wrong')

    await rotate(page)
    await page.getByRole('button', { name: 'Open editor' }).click()
    await expect(page.locator('.editor-screen')).toBeVisible()
    await shot('editor_portrait_film')

    await page.getByRole('button', { name: 'Play project preview' }).click()
    await expect(page.locator('.playback-overlay')).toBeVisible()
    const overlay = page.locator('.playback-overlay')
    const playFilm = overlay.locator('> .film-frame')
    const overlayBox = await overlay.boundingBox()
    const playBox = await playFilm.boundingBox()
    expect(overlayBox).not.toBeNull()
    expect(playBox).not.toBeNull()
    expect(playBox!.width / playBox!.height).toBeCloseTo(9 / 16, 2)
    expect(Math.abs(playBox!.x + playBox!.width / 2 - (overlayBox!.x + overlayBox!.width / 2))).toBeLessThan(4)
    expect(Math.abs(playBox!.y + playBox!.height / 2 - (overlayBox!.y + overlayBox!.height / 2))).toBeLessThan(4)
    await shot('playback_portrait_film')
  })

  test('a landscape clip is side-cropped in a portrait film', async ({ page }, testInfo) => {
    await gotoHome(page)
    await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      const thumbs = await import('/src/lib/thumbs.ts')
      const { makeLabeledClipBlob } = await import('/src/lib/testing/make-test-clip.ts')
      const width = 640
      const height = 360
      const blob = await makeLabeledClipBlob(width, height)
      const project = await storage.createProject('Wide in tall')
      const clip = await storage.addClip({
        projectId: project.id,
        blob,
        mimeType: 'video/webm',
        durationMs: 1200,
        width,
        height,
      })
      await thumbs.ensureClipThumbs(clip)
    })
    await page.goto('/')
    await page.locator('.project-slot:not(.empty)').first().click()
    await page.getByRole('button', { name: 'Open editor' }).click()
    await expect(page.locator('.editor-screen')).toBeVisible()
    await expect(page.locator('.project-screen')).toHaveClass(/is-film-framed/)
    const preview = page.locator('.editor-clip-preview')
    await expect
      .poll(() => preview.evaluate((el) => (el as HTMLVideoElement).videoWidth))
      .toBeGreaterThan(0)
    const file = testInfo.outputPath('editor_landscape_clip_cropped.png')
    await page.screenshot({ path: file, fullPage: false })
    await page.screenshot({
      path: '/opt/cursor/artifacts/editor_landscape_clip_cropped.png',
      fullPage: false,
    })
  })
})
