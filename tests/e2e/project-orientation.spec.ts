import { test, expect } from '@playwright/test'
import {
  openNewProject,
  recordClip,
  seedProject,
  unlockPlus,
  waitForCameraReady,
} from './helpers'

async function shellOrientation(page: import('@playwright/test').Page) {
  return page.evaluate(() => document.documentElement.dataset.projectOrientation)
}

// Rotate-to-choose (the touch flow: follow the device, lock on the first
// take, free-plan gate) lives in orientation-touch.spec.ts under the touch
// Playwright project. This file covers what locked projects do everywhere
// and the fine-pointer (desktop-like) exemption.
test.describe('project orientation', () => {
  test('a locked landscape project shifts the shell, persists, and hints upright', async ({
    page,
  }) => {
    const projectId = await seedProject(page, { clips: 2 })
    await unlockPlus(page)
    await page.evaluate(async (id) => {
      const storage = await import('/src/lib/storage.ts')
      await storage.setProjectOrientation(id, 'landscape')
    }, projectId)
    await page.goto(`/project/${projectId}`)
    await waitForCameraReady(page)

    // The whole interface swings: document-level data attribute (widens the
    // shell via CSS) + the page-level class.
    await expect.poll(() => shellOrientation(page)).toBe('landscape')
    await expect(page.locator('.project-screen.orientation-landscape')).toBeVisible()

    // Held upright (portrait viewport), the app asks for a turn.
    await expect(page.locator('.orientation-hint')).toBeVisible()
    await expect(page.locator('.orientation-hint')).toContainText(/turn your device/i)

    // A reload keeps the landscape interface — the lock is on the project.
    await page.reload()
    await waitForCameraReady(page)
    await expect.poll(() => shellOrientation(page)).toBe('landscape')

    // Turn the phone: the hint goes away and the dock becomes a right-hand
    // rail (taller than wide, hugging the shell's right edge — at wide
    // viewports the shell itself sits centered in the desktop frame).
    const viewport = page.viewportSize()!
    await page.setViewportSize({ width: viewport.height, height: viewport.width })
    await expect(page.locator('.orientation-hint')).toBeHidden()
    const dock = await page.locator('.record-dock').boundingBox()
    const shell = await page.locator('.project-screen').boundingBox()
    expect(dock).not.toBeNull()
    expect(shell).not.toBeNull()
    expect(dock!.height).toBeGreaterThan(dock!.width)
    expect(dock!.x + dock!.width).toBeGreaterThan(shell!.x + shell!.width - 8)

    // The editor, sideways, puts the player beside the panel. Polled: the
    // stage mounts with a brief scale-in animation that inflates its
    // bounding box until it settles.
    await page.locator('[aria-label="Open editor"]').click()
    await expect
      .poll(async () => {
        const stage = await page.locator('.editor-stage').boundingBox()
        const panel = await page.locator('.editor-panel').boundingBox()
        if (!stage || !panel) return false
        return panel.x >= stage.x + stage.width - 2
      })
      .toBe(true)
  })

  test('fine-pointer (desktop-like) recording never locks an orientation', async ({ page }) => {
    // Webcams and screen shares are landscape media without that being a
    // choice — desktop projects stay unlocked and keep the classic column.
    await openNewProject(page)

    await recordClip(page)

    const orientation = await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      return (await storage.listProjects())[0]?.orientation
    })
    expect(orientation).toBeUndefined()
    expect(await shellOrientation(page)).toBe('portrait')
  })

  test('landscape projects export a landscape file from portrait clips', async ({ page }) => {
    // Through the real project boundary: a locked landscape project,
    // exported with the Go button — portrait fixture clips (320×568) must
    // come out 568×320 (the same cover-fit center crop the preview shows).
    const projectId = await seedProject(page, { clips: 1 })
    await unlockPlus(page)
    await page.evaluate(async (id) => {
      const storage = await import('/src/lib/storage.ts')
      await storage.setProjectOrientation(id, 'landscape')
    }, projectId)
    await page.goto(`/project/${projectId}`)
    await waitForCameraReady(page)

    await page.locator('.go-button').click()
    await expect(page.getByText('Done! Your video is ready')).toBeVisible({ timeout: 60_000 })

    // The finished export persists (in the background) as the recoverable
    // last export — measure that exact file.
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const storage = await import('/src/lib/storage.ts')
            const opfs = await import('/src/lib/export/opfs.ts')
            const last = (await storage.getSettings()).lastExport
            if (!last) return null
            const file = await opfs.readOpfsFile(last.opfsName)
            if (!file || file.size === 0) return null
            const video = document.createElement('video')
            video.src = URL.createObjectURL(new Blob([file], { type: last.mimeType }))
            await new Promise((resolve, reject) => {
              video.onloadedmetadata = () => resolve(null)
              video.onerror = () => reject(new Error('exported file failed to load'))
            })
            return { width: video.videoWidth, height: video.videoHeight }
          }),
        { timeout: 20_000 },
      )
      .toEqual({ width: 568, height: 320 })
  })
})
