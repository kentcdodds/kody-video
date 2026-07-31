import { test, expect } from '@playwright/test'
import {
  openNewProject,
  pressStageUntilRecording,
  recordClip,
  totalClipCount,
} from './helpers'

test.describe('camera & hold-to-record', () => {
  test('allow shows a live preview; hold records a clip and creates the project', async ({
    page,
  }) => {
    await openNewProject(page)
    await expect(page.locator('.hold-hint')).toContainText(/hold anywhere/i)

    await recordClip(page)
    // Lazy creation: the first take flips /project/new to the real id.
    await page.waitForURL((url) => !url.pathname.endsWith('/project/new'))
    const projects = await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      return (await storage.listProjects()).length
    })
    expect(projects).toBe(1)

    // A second hold appends to the same project.
    await recordClip(page)
    expect(await totalClipCount(page)).toBe(2)
  })

  test('recording shows the REC pill with elapsed time', async ({ page }) => {
    await openNewProject(page)
    await pressStageUntilRecording(page)
    const pill = page.locator('.record-pill')
    await expect(pill).toContainText('REC')
    await expect(pill.locator('.record-elapsed')).toContainText(/\d+\.\ds/)
    await page.mouse.up()
    await expect(pill).toBeHidden()
  })

  test('a very short tap does not create an empty clip', async ({ page }) => {
    await openNewProject(page)
    const stage = page.locator('.record-stage')
    const box = await stage.boundingBox()
    if (!box) throw new Error('no stage')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(30)
    await page.mouse.up()
    await expect(page.locator('.toast')).toContainText('Hold a bit longer')
    expect(await totalClipCount(page)).toBe(0)
  })

  test('delete last clip offers Undo, and Undo restores it', async ({ page }) => {
    await openNewProject(page)
    await recordClip(page)
    await page.getByRole('button', { name: 'Delete last clip' }).click()
    await expect(page.locator('.toast')).toContainText('Last clip deleted')
    expect(await totalClipCount(page)).toBe(0)
    await page.locator('.toast').getByRole('button', { name: 'Undo' }).click()
    await expect(page.locator('.toast')).toContainText('Clip restored')
    expect(await totalClipCount(page)).toBe(1)
  })

  test('self-timer counts down and records hands-free until tapped', async ({ page }) => {
    await openNewProject(page)
    await page.getByRole('button', { name: 'Self-timer' }).click()
    await expect(page.locator('.countdown-overlay')).toBeVisible()
    const pill = page.locator('.record-pill')
    await expect(pill).toContainText('TAP TO STOP', { timeout: 15_000 })
    await page.waitForTimeout(700)
    const stage = page.locator('.record-stage')
    await stage.click({ position: { x: 100, y: 200 } })
    await expect.poll(() => totalClipCount(page), { timeout: 15_000 }).toBe(1)
  })

  test('denied camera shows the permission panel with retry', async ({ browser }) => {
    const context = await browser.newContext()
    await context.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
    })
    const page = await context.newPage()
    await page.goto('/')
    await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      await storage.setOnboardingDismissed(true)
    })
    await page.getByRole('button', { name: 'New project', exact: true }).click()
    const panel = page.locator('.permission-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('Camera access')
    await expect(panel.getByRole('button', { name: 'Try again' })).toBeVisible()
    await context.close()
  })

  test('location tagging geotags new clips while on', async ({ context, page }) => {
    await context.grantPermissions(['camera', 'microphone', 'geolocation'])
    await context.setGeolocation({ latitude: 40.2338, longitude: -111.6585, accuracy: 12 })
    await openNewProject(page)
    const toggle = page.getByRole('button', { name: 'Toggle location tagging' })
    await toggle.click()
    await expect(page.locator('.toast')).toContainText('Location tagging on')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')

    await recordClip(page)
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const storage = await import('/src/lib/storage.ts')
            const projects = await storage.listProjects()
            if (projects.length === 0) return null
            const clips = await storage.getClipMetasForProject(projects[0]!.id)
            const clip = clips[0] as { lat?: number; lng?: number } | undefined
            return clip?.lat != null && clip?.lng != null
              ? { lat: clip.lat, lng: clip.lng }
              : null
          }),
        { timeout: 15_000 },
      )
      .toEqual({ lat: 40.2338, lng: -111.6585 })
  })
})
