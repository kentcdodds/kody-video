import { test, expect, type Page } from '@playwright/test'
import { openNewProject, openSeededProject, seedProject, totalClipCount } from './helpers'

async function recordViaSpace(page: Page, holdMs: number): Promise<void> {
  await page.keyboard.down('Space')
  await page.waitForTimeout(holdMs)
  await page.keyboard.up('Space')
}

test.describe('desktop keyboard', () => {
  test('key hints render on fine-pointer devices', async ({ page }) => {
    await openNewProject(page)
    await expect(page.locator('.key-hints').first()).toBeVisible()
  })

  test('hold Space records; a sub-120ms tap never sticks', async ({ page }) => {
    await openNewProject(page)
    await recordViaSpace(page, 900)
    await expect.poll(() => totalClipCount(page), { timeout: 15_000 }).toBe(1)
    await expect(page.locator('.record-pill')).toBeHidden()

    await recordViaSpace(page, 40)
    await expect(page.locator('.record-pill')).toBeHidden()
    await expect(page.locator('.toast')).toContainText('Hold a bit longer')
    expect(await totalClipCount(page)).toBe(1)
  })

  test('E opens editor, Esc returns, P plays, Delete removes last clip', async ({ page }) => {
    // Playback auto-closes when the cut ends — a long clip keeps the
    // overlay up while the P/Escape assertions run.
    await openSeededProject(page, { clips: 1, clipMs: 4000 })

    await page.keyboard.press('e')
    await expect(page.locator('.editor-screen')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.record-stage')).toBeVisible()

    await page.keyboard.press('p')
    const overlay = page.locator('.playback-overlay')
    await expect(overlay).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(overlay).toBeHidden()

    await page.keyboard.press('Delete')
    await expect(page.locator('.toast')).toContainText('Last clip deleted')
    expect(await totalClipCount(page)).toBe(0)
  })

  test('editor: arrows select, Alt+arrows reorder, D duplicates, Delete deletes, T trims', async ({
    page,
  }) => {
    await openSeededProject(page, { clips: 2 })
    await page.keyboard.press('e')
    const tiles = page.locator('.clip-thumb')
    await expect(tiles).toHaveCount(2)

    await page.keyboard.press('ArrowRight')
    await expect(tiles.nth(1)).toHaveClass(/selected/)
    await page.keyboard.press('ArrowLeft')
    await expect(tiles.nth(0)).toHaveClass(/selected/)

    const firstId = await tiles.nth(0).getAttribute('data-clip-id')
    await page.keyboard.press('Alt+ArrowRight')
    await expect
      .poll(() => tiles.nth(1).getAttribute('data-clip-id'))
      .toBe(firstId)
    await page.keyboard.press('Alt+ArrowLeft')
    await expect
      .poll(() => tiles.nth(0).getAttribute('data-clip-id'))
      .toBe(firstId)

    await page.keyboard.press('d')
    await expect(tiles).toHaveCount(3)
    await page.keyboard.press('Delete')
    await expect(tiles).toHaveCount(2)

    await page.keyboard.press('t')
    await expect(page.locator('.trim-strip')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.trim-strip')).toBeHidden()
  })

  test('playback: Space pauses and resumes, arrows skip clips', async ({ page }) => {
    // Long clips: playback auto-closes at the end of the cut.
    await openSeededProject(page, { clips: 2, clipMs: 4000 })
    await page.keyboard.press('p')
    const overlay = page.locator('.playback-overlay')
    await expect(overlay).toBeVisible()
    const video = overlay.locator('.playback-video')
    await expect.poll(() => video.evaluate((el) => !(el as HTMLVideoElement).paused)).toBe(true)

    await page.keyboard.press('Space')
    await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).paused)).toBe(true)
    await page.keyboard.press('Space')
    await expect.poll(() => video.evaluate((el) => !(el as HTMLVideoElement).paused)).toBe(true)

    await page.keyboard.press('ArrowRight')
    await expect(overlay.locator('.playback-caption')).toContainText('Clip 2 / 2')
    await page.keyboard.press('ArrowLeft')
    await expect(overlay.locator('.playback-caption')).toContainText('Clip 1 / 2')
    await page.keyboard.press('Escape')
    await expect(overlay).toBeHidden()
  })

  test('typing in the rename field never triggers shortcuts', async ({ page }) => {
    await seedProject(page, { clips: 1 })
    await page.reload()

    await page.locator('.slot-options').click()
    await page.getByRole('button', { name: 'Rename' }).click()
    const input = page.locator('#project-name')
    await input.fill('')
    // 'e', 'p', 'd', 't' are all shortcuts elsewhere — typed here they must
    // just be text.
    await input.pressSequentially('deept', { delay: 20 })
    await expect(input).toHaveValue('deept')
    await expect(page.locator('.editor-screen')).toBeHidden()
    await expect(page.locator('.playback-overlay')).toBeHidden()
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.locator('.project-slot.filled')).toContainText('deept')
  })
})
