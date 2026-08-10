import { test, expect, type Page } from '@playwright/test'
import {
  openNewProject,
  recordClip,
  seedProject,
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

/** How the shell is counter-rotated out of the device's auto-rotate. */
async function shellPin(page: Page) {
  return page.evaluate(() => document.documentElement.dataset.rotate)
}

/** The shell's own (pre-transform) box — the shape it lays itself out in. */
async function shellBox(page: Page) {
  return page.locator('#root').evaluate((el) => ({
    width: el.clientWidth,
    height: el.clientHeight,
  }))
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

    // From now on the interface is stuck landscape: turning the phone back
    // upright pins it — the shell counter-rotates and keeps its landscape
    // BOX (as wide as the upright viewport is tall), so neither the layout
    // nor the camera's shape follows the device. It asks for a turn instead.
    await rotate(page)
    await expect.poll(() => shellLayout(page)).toBe('wide')
    await expect.poll(() => shellPin(page)).toMatch(/^(cw|ccw)$/)
    const upright = page.viewportSize()!
    await expect
      .poll(() => shellBox(page))
      .toEqual({ width: upright.height, height: upright.width })
    await expect(page.locator('.orientation-hint')).toBeVisible()
    await expect(page.locator('.orientation-hint')).toContainText(/turn your device sideways/i)

    // Survives a reload.
    await page.reload()
    await page.locator('.camera-video').waitFor()
    await expect.poll(() => shellLayout(page)).toBe('wide')
    await expect.poll(() => shellPin(page)).toMatch(/^(cw|ccw)$/)
  })

  test('a portrait-locked project stays portrait when the phone is turned', async ({ page }) => {
    // The mirror of the landscape lock, and the common case: a portrait film
    // must not reflow (or reframe the camera) because the phone was tilted.
    const projectId = await seedProject(page, { clips: 1 })
    await page.evaluate(async (id) => {
      const storage = await import('/src/lib/storage.ts')
      await storage.setProjectOrientation(id, 'portrait')
    }, projectId)
    await page.goto(`/project/${projectId}`)
    await waitForCameraReady(page)
    await expect.poll(() => shellLayout(page)).toBe('narrow')
    expect(await shellPin(page)).toBeUndefined()

    const upright = page.viewportSize()!
    const portraitStage = await page.locator('.record-stage').boundingBox()

    // Turn the phone sideways: the interface is pinned, so the stage keeps
    // the shape (and size) it had upright, and the portrait layout stands.
    await rotate(page)
    await expect.poll(() => shellPin(page)).toMatch(/^(cw|ccw)$/)
    await expect.poll(() => shellLayout(page)).toBe('narrow')
    await expect(page.locator('.project-screen.orientation-landscape')).toBeHidden()
    // The shell still lays itself out upright-shaped; only the transform
    // turns it, so its own width now runs down the (landscape) viewport.
    await expect
      .poll(() => shellBox(page))
      .toEqual({ width: upright.width, height: upright.height })
    const pinnedStage = await page.locator('.record-stage').boundingBox()
    expect(Math.round(pinnedStage!.width)).toBe(Math.round(portraitStage!.height))
    expect(Math.round(pinnedStage!.height)).toBe(Math.round(portraitStage!.width))

    // And it says which way to hold the phone.
    await expect(page.locator('.orientation-hint-portrait')).toBeVisible()
    await expect(page.locator('.orientation-hint-portrait')).toContainText(
      /turn your device upright/i,
    )
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
    // portrait (stored, so the lock is told apart from a project that never
    // locked one — whose export still follows its clips).
    await rotate(page)
    await expect.poll(() => shellLayout(page)).toBe('narrow')
    await expect(page.locator('.orientation-gate-pill')).toBeHidden()
    await recordClip(page)
    expect(await storedOrientation(page)).toBe('portrait')
    expect(
      await page.evaluate(async () => {
        const storage = await import('/src/lib/storage.ts')
        return (await storage.listProjects()).length
      }),
    ).toBe(1)
  })
})
