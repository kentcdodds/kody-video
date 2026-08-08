import { test, expect, type Page } from '@playwright/test'
import { openNewProject, recordClip, totalClipCount, unlockPlus } from './helpers'

// Runs under the `touch` Playwright project (real touch emulation, so
// `pointer: coarse` matches): the rotate-to-choose flow only exists on
// devices that are physically held.

async function shellOrientation(page: Page) {
  return page.evaluate(() => document.documentElement.dataset.projectOrientation)
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
    await expect.poll(() => shellOrientation(page)).toBe('portrait')

    // Turn the phone: the interface follows (no upsell — Plus).
    await rotate(page)
    await expect.poll(() => shellOrientation(page)).toBe('landscape')
    await expect(page.locator('.project-screen.orientation-landscape')).toBeVisible()
    await expect(page.locator('.sheet[aria-label="Kody Video Plus"]')).toBeHidden()

    // The first take decides: recording sideways locks the project landscape.
    await recordClip(page)
    await expect.poll(() => storedOrientation(page)).toBe('landscape')

    // From now on the interface is stuck landscape — turning the phone back
    // upright keeps the landscape layout and asks for a turn instead.
    await rotate(page)
    await expect.poll(() => shellOrientation(page)).toBe('landscape')
    await expect(page.locator('.orientation-hint')).toBeVisible()
    await expect(page.locator('.orientation-hint')).toContainText(/turn your device sideways/i)

    // Survives a reload.
    await page.reload()
    await page.locator('.camera-video').waitFor()
    await expect.poll(() => shellOrientation(page)).toBe('landscape')
  })

  test('free plan: rotating previews landscape but the take is gated behind Plus', async ({
    page,
  }) => {
    await openNewProject(page)
    await expect.poll(() => shellOrientation(page)).toBe('portrait')

    // Turn the phone: the layout shifts (the preview IS the pitch) and the
    // upsell opens to explain the gate.
    await rotate(page)
    await expect.poll(() => shellOrientation(page)).toBe('landscape')
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
    await expect.poll(() => shellOrientation(page)).toBe('portrait')
    await expect(page.locator('.orientation-gate-pill')).toBeHidden()
    await recordClip(page)
    expect(await storedOrientation(page)).toBeUndefined()
    expect(
      await page.evaluate(async () => {
        const storage = await import('/src/lib/storage.ts')
        return (await storage.listProjects()).length
      }),
    ).toBe(1)
  })
})
