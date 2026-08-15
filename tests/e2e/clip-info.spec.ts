import { test, expect, type Page } from '@playwright/test'
import { openSeededProject } from './helpers'

async function openEditorWithClips(page: Page, clips: number, clipMs?: number): Promise<void> {
  await openSeededProject(page, { clips, clipMs, name: 'Facts' })
  await page.getByRole('button', { name: 'Open editor' }).click()
  await expect(page.locator('.editor-screen')).toBeVisible()
}

async function openClipInfo(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Clip info' }).click()
  await expect(page.getByRole('dialog', { name: /clip \d+ info/i })).toBeVisible()
}

test.describe('clip info sheet', () => {
  test('info button opens facts about the selected clip', async ({ page }) => {
    await openEditorWithClips(page, 2, 1500)
    await page.locator('.clip-thumb').first().click()
    await openClipInfo(page)
    const sheet = page.locator('.clip-info-sheet')
    await expect(sheet.getByText('1 of 2')).toBeVisible()
    await expect(sheet.getByText(/1\.5s/)).toBeVisible()
    await expect(sheet.getByText(/WebM/)).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Download' })).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Split clip' })).toBeVisible()
    await expect(sheet.getByText(/handle on the filmstrip/i)).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Permanently trim' })).toBeDisabled()
  })

  test('download saves the selected clip', async ({ page }) => {
    await openEditorWithClips(page, 1)
    await openClipInfo(page)
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download' }).click(),
    ])
    expect(download.suggestedFilename()).toMatch(/facts-clip-01\.webm/)
  })

  test('split opens a filmstrip handle, then cuts at the chosen point', async ({ page }) => {
    const clipMs = 4000
    await openEditorWithClips(page, 1, clipMs)
    const tiles = page.locator('.clip-thumb[data-clip-id]')
    await expect(tiles).toHaveCount(1)
    await openClipInfo(page)
    await page.getByRole('button', { name: 'Split clip' }).click()
    await expect(page.getByRole('dialog', { name: /clip \d+ info/i })).toBeHidden()

    const strip = page.locator('.split-strip')
    await expect(strip).toBeVisible()
    await expect(strip.getByText(/drag the line/i)).toBeVisible()
    const handle = strip.getByRole('slider', { name: 'Split point' })
    await expect(handle).toBeVisible()

    const preview = page.locator('.editor-clip-preview')
    const previewTime = () => preview.evaluate((el) => (el as HTMLVideoElement).currentTime)
    const track = await strip.locator('.trim-strip-track').boundingBox()
    const handleBox = await handle.boundingBox()
    if (!track || !handleBox) throw new Error('split geometry unavailable')
    const y = handleBox.y + handleBox.height / 2
    const xAt = (fraction: number) => track.x + track.width * fraction
    await page.mouse.move(handleBox.x + handleBox.width / 2, y)
    await page.mouse.down()
    await page.mouse.move(xAt(0.25), y, { steps: 8 })
    await expect.poll(previewTime).toBeGreaterThan(0.25 * (clipMs / 1000) - 0.25)
    expect(await previewTime()).toBeLessThan(0.25 * (clipMs / 1000) + 0.25)
    await page.mouse.up()

    await strip.getByRole('button', { name: 'Split' }).click()
    await expect(page.locator('.toast')).toContainText('Clip split', { timeout: 20_000 })
    await expect(tiles).toHaveCount(2, { timeout: 20_000 })
  })

  test('canceling split leaves the timeline unchanged', async ({ page }) => {
    await openEditorWithClips(page, 1, 1600)
    const tiles = page.locator('.clip-thumb[data-clip-id]')
    await expect(tiles).toHaveCount(1)
    await openClipInfo(page)
    await page.getByRole('button', { name: 'Split clip' }).click()
    const strip = page.locator('.split-strip')
    await expect(strip).toBeVisible()
    await strip.getByRole('button', { name: 'Cancel' }).click()
    await expect(strip).toBeHidden()
    await expect(tiles).toHaveCount(1)
  })

  test('permanently trim deletes unused media from the file', async ({ page }) => {
    await openEditorWithClips(page, 1, 2000)
    await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      const projects = await storage.listProjects()
      const clips = await storage.getClipMetasForProject(projects[0]!.id)
      await storage.updateClipTrim(clips[0]!.id, 400, 1400)
    })
    await page.reload()
    await page.getByRole('button', { name: 'Open editor' }).click()
    await expect(page.locator('.editor-screen')).toBeVisible()

    await openClipInfo(page)
    const sheet = page.locator('.clip-info-sheet')
    await expect(sheet.getByRole('button', { name: 'Permanently trim' })).toBeEnabled()
    await sheet.getByRole('button', { name: 'Permanently trim' }).click()
    await sheet.getByRole('button', { name: 'Delete unused parts' }).click()
    await expect(page.locator('.toast')).toContainText('Unused parts deleted', { timeout: 20_000 })

    const after = await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      const projects = await storage.listProjects()
      const clips = await storage.getClipMetasForProject(projects[0]!.id)
      const clip = clips[0]!
      return {
        durationMs: clip.durationMs,
        trimStartMs: clip.trimStartMs,
        trimEndMs: clip.trimEndMs,
      }
    })
    expect(after.durationMs).toBeGreaterThanOrEqual(700)
    expect(after.durationMs).toBeLessThan(1800)
    expect(after.trimStartMs).toBe(0)
    expect(after.trimEndMs).toBe(after.durationMs)
  })
})
