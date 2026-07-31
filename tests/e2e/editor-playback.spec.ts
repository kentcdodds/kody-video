import { test, expect, type Page } from '@playwright/test'
import { openSeededProject } from './helpers'

async function openEditorWithClips(page: Page, clips: number, clipMs?: number): Promise<void> {
  await openSeededProject(page, { clips, clipMs })
  await page.getByRole('button', { name: 'Open editor' }).click()
  await expect(page.locator('.editor-screen')).toBeVisible()
}

test.describe('editor', () => {
  test('timeline shows a selectable tile per clip with thumbnails', async ({ page }) => {
    await openEditorWithClips(page, 2)
    const tiles = page.locator('.clip-thumb')
    await expect(tiles).toHaveCount(2)
    // The editor opens at the most recent clip.
    await expect(tiles.last()).toHaveClass(/selected/)
    await tiles.first().click()
    await expect(tiles.first()).toHaveClass(/selected/)
    // Thumbnails are generated asynchronously but must arrive.
    await expect(tiles.first().locator('.clip-filmstrip-frame').first()).toBeVisible({
      timeout: 15_000,
    })
  })

  test('duplicate inserts a copy after the selection', async ({ page }) => {
    await openEditorWithClips(page, 2)
    const tiles = page.locator('.clip-thumb')
    const firstId = await tiles.nth(0).getAttribute('data-clip-id')
    const secondId = await tiles.nth(1).getAttribute('data-clip-id')
    await tiles.first().click()
    await page.getByRole('button', { name: 'Duplicate clip' }).click()
    await expect(tiles).toHaveCount(3)
    // Copy lands right after the selected first clip: [first, copy, second].
    expect(await tiles.nth(0).getAttribute('data-clip-id')).toBe(firstId)
    expect(await tiles.nth(1).getAttribute('data-clip-id')).not.toBe(firstId)
    expect(await tiles.nth(1).getAttribute('data-clip-id')).not.toBe(secondId)
    expect(await tiles.nth(2).getAttribute('data-clip-id')).toBe(secondId)
  })

  test('delete offers Undo and Undo restores the clip', async ({ page }) => {
    await openEditorWithClips(page, 2)
    const tiles = page.locator('.clip-thumb')
    await page.getByRole('button', { name: 'Delete clip' }).click()
    await expect(page.locator('.toast')).toContainText('Clip deleted')
    await expect(tiles).toHaveCount(1)
    await page.locator('.toast').getByRole('button', { name: 'Undo' }).click()
    await expect(tiles).toHaveCount(2)
  })

  test('trim opens the strip; dragging a handle and Done persists', async ({ page }) => {
    await openEditorWithClips(page, 1)
    const durBefore = (await page.locator('.clip-thumb .clip-dur').first().textContent()) ?? ''

    await page.getByRole('button', { name: 'Trim' }).click()
    const strip = page.locator('.trim-strip')
    await expect(strip).toBeVisible()
    await expect(strip.locator('.trim-handle-left')).toBeVisible()
    await expect(strip.locator('.trim-handle-right')).toBeVisible()

    // Drag the end handle toward the start to shorten the clip.
    const handle = strip.locator('.trim-handle-right')
    const handleBox = await handle.boundingBox()
    const trackBox = await strip.locator('.trim-strip-track').boundingBox()
    if (!handleBox || !trackBox) throw new Error('trim geometry unavailable')
    const startX = handleBox.x + handleBox.width / 2
    const y = handleBox.y + handleBox.height / 2
    await page.mouse.move(startX, y)
    await page.mouse.down()
    await page.mouse.move(startX - trackBox.width * 0.4, y, { steps: 8 })
    await page.mouse.up()
    await strip.getByRole('button', { name: 'Done' }).click()
    await expect(strip).toBeHidden()

    const trim = await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      const projects = await storage.listProjects()
      const clips = await storage.getClipMetasForProject(projects[0]!.id)
      const clip = clips[0] as { trimEndMs?: number; durationMs?: number }
      return { trimEndMs: clip.trimEndMs ?? null, durationMs: clip.durationMs ?? 0 }
    })
    expect(trim.trimEndMs).not.toBeNull()
    expect(trim.trimEndMs!).toBeLessThan(trim.durationMs)

    const durAfter = (await page.locator('.clip-thumb .clip-dur').first().textContent()) ?? ''
    expect(durAfter).not.toBe(durBefore)
  })

  test('back returns to the camera', async ({ page }) => {
    await openEditorWithClips(page, 1)
    await page.getByRole('button', { name: 'Back to camera' }).click()
    await expect(page.locator('.record-stage')).toBeVisible()
  })
})

test.describe('preview playback', () => {
  test('plays the cut with segmented progress; edge taps skip; middle stops', async ({
    page,
  }) => {
    // Long-ish clips: playback auto-closes when the cut ends, so the
    // assertions below need a comfortable window.
    await openSeededProject(page, { clips: 2, clipMs: 4000 })

    await page.getByRole('button', { name: 'Play project preview' }).click()
    const overlay = page.locator('.playback-overlay')
    await expect(overlay).toBeVisible()
    await expect(overlay.locator('.playback-progress > span')).toHaveCount(2)
    await expect(overlay.locator('.playback-caption')).toContainText('Clip 1 / 2')
    await expect
      .poll(() =>
        overlay
          .locator('.playback-video')
          .evaluate((el) => !(el as HTMLVideoElement).paused),
      )
      .toBe(true)

    await overlay.getByRole('button', { name: 'Next clip' }).click()
    await expect(overlay.locator('.playback-caption')).toContainText('Clip 2 / 2')
    await overlay.getByRole('button', { name: 'Previous clip' }).click()
    await expect(overlay.locator('.playback-caption')).toContainText('Clip 1 / 2')

    await overlay.getByRole('button', { name: 'Stop preview' }).click()
    await expect(overlay).toBeHidden()
    await expect(page.locator('.record-stage')).toBeVisible()
  })
})
