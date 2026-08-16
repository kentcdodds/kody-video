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

  test('delete selects the previous clip, or the next when it was first', async ({ page }) => {
    await openEditorWithClips(page, 3)
    const tiles = page.locator('.clip-thumb')
    const firstId = await tiles.nth(0).getAttribute('data-clip-id')
    const thirdId = await tiles.nth(2).getAttribute('data-clip-id')
    await tiles.nth(1).click()
    await page.getByRole('button', { name: 'Delete clip' }).click()
    await expect(tiles).toHaveCount(2)
    await expect(tiles.nth(0)).toHaveAttribute('data-clip-id', firstId!)
    await expect(tiles.nth(0)).toHaveClass(/selected/)

    await page.getByRole('button', { name: 'Delete clip' }).click()
    await expect(tiles).toHaveCount(1)
    await expect(tiles.nth(0)).toHaveAttribute('data-clip-id', thirdId!)
    await expect(tiles.nth(0)).toHaveClass(/selected/)
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

  test('trim preview scrubs to the frame at the dragged handle', async ({ page }) => {
    const clipMs = 4000
    await openEditorWithClips(page, 1, clipMs)
    const preview = page.locator('.editor-clip-preview')
    const previewTime = () => preview.evaluate((el) => (el as HTMLVideoElement).currentTime)

    await page.getByRole('button', { name: 'Trim' }).click()
    const strip = page.locator('.trim-strip')
    await expect(strip).toBeVisible()

    const track = await strip.locator('.trim-strip-track').boundingBox()
    if (!track) throw new Error('trim geometry unavailable')
    // Handles are centered on their time position (translateX(-50%)), so an
    // x fraction of the track maps straight to a fraction of the duration.
    const xAt = (fraction: number) => track.x + track.width * fraction
    const secondsNear = async (fraction: number) => {
      const target = (clipMs / 1000) * fraction
      await expect.poll(previewTime).toBeGreaterThan(target - 0.25)
      expect(await previewTime()).toBeLessThan(target + 0.25)
    }

    // Drag the end handle to the middle; the preview must scrub with it.
    const endBox = await strip.locator('.trim-handle-right').boundingBox()
    if (!endBox) throw new Error('trim geometry unavailable')
    const y = endBox.y + endBox.height / 2
    await page.mouse.move(endBox.x + endBox.width / 2, y)
    await page.mouse.down()
    await page.mouse.move(xAt(0.5), y, { steps: 8 })
    await secondsNear(0.5)
    await page.mouse.up()

    // Same for the start handle.
    const startBox = await strip.locator('.trim-handle-left').boundingBox()
    if (!startBox) throw new Error('trim geometry unavailable')
    await page.mouse.move(startBox.x + startBox.width / 2, y)
    await page.mouse.down()
    await page.mouse.move(xAt(0.25), y, { steps: 8 })
    await secondsNear(0.25)
    await page.mouse.up()

    await strip.getByRole('button', { name: 'Done' }).click()
    await expect(strip).toBeHidden()

    // Re-opening trim starts the preview on the saved trim-start frame, not
    // frame zero.
    await page.getByRole('button', { name: 'Trim' }).click()
    await expect(strip).toBeVisible()
    await secondsNear(0.25)
  })

  test('back returns to the camera', async ({ page }) => {
    await openEditorWithClips(page, 1)
    await page.getByRole('button', { name: 'Back to camera' }).click()
    await expect(page.locator('.record-stage')).toBeVisible()
  })

  test('Add imports a device video onto the timeline', async ({ page }) => {
    await openEditorWithClips(page, 1)
    const tiles = page.locator('.clip-thumb[data-clip-id]')
    await expect(tiles).toHaveCount(1)

    const clipPath = await page.evaluate(async () => {
      const { makeTestClipBlob } = await import('/src/lib/testing/make-test-clip.ts')
      const blob = await makeTestClipBlob(1200)
      const buffer = await blob.arrayBuffer()
      const bytes = Array.from(new Uint8Array(buffer))
      return { bytes, type: blob.type || 'video/webm' }
    })
    const file = {
      name: 'from-device.webm',
      mimeType: clipPath.type,
      buffer: Buffer.from(clipPath.bytes),
    }

    // Drive the toolbar Add control through the real file chooser so a
    // disconnected hidden input cannot fake a green test.
    const chooserPromise = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Add clips from device' }).first().click()
    const chooser = await chooserPromise
    await chooser.setFiles(file)
    await expect(tiles).toHaveCount(2, { timeout: 20_000 })
    await expect(page.locator('.toast')).toContainText(/clip added/i)
    // The imported clip is selected (most recently added).
    await expect(tiles.last()).toHaveClass(/selected/)

    const stored = await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      const projects = await storage.listProjects()
      const clips = await storage.getClipMetasForProject(projects[0]!.id)
      return clips.map((clip: { durationMs: number; mimeType: string; width?: number; height?: number }) => ({
        durationMs: clip.durationMs,
        mimeType: clip.mimeType,
        width: clip.width ?? null,
        height: clip.height ?? null,
      }))
    })
    expect(stored).toHaveLength(2)
    const imported = stored[1]!
    expect(imported.durationMs).toBeGreaterThan(500)
    expect(imported.mimeType).toMatch(/video\//)
    expect(imported.width).toBeGreaterThan(0)
    expect(imported.height).toBeGreaterThan(0)

    // The post-import refresh auto-normalizes the new clip: its audio peak
    // is measured and persisted by the loader backfill.
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const storage = await import('/src/lib/storage.ts')
            const projects = await storage.listProjects()
            const clips = await storage.getClipMetasForProject(projects[0]!.id)
            return clips.every(
              (clip: { audioPeak?: number }) => typeof clip.audioPeak === 'number',
            )
          }),
        { timeout: 20_000 },
      )
      .toBe(true)
  })

  test('Add inserts the new clip after the selected one', async ({ page }) => {
    await openEditorWithClips(page, 2)
    const tiles = page.locator('.clip-thumb[data-clip-id]')
    await expect(tiles).toHaveCount(2)
    const firstId = await tiles.nth(0).getAttribute('data-clip-id')
    const secondId = await tiles.nth(1).getAttribute('data-clip-id')
    await tiles.first().click()

    const clipPath = await page.evaluate(async () => {
      const { makeTestClipBlob } = await import('/src/lib/testing/make-test-clip.ts')
      const blob = await makeTestClipBlob(800)
      const buffer = await blob.arrayBuffer()
      return { bytes: Array.from(new Uint8Array(buffer)), type: blob.type || 'video/webm' }
    })
    const chooserPromise = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Add clips from device' }).first().click()
    const chooser = await chooserPromise
    await chooser.setFiles({
      name: 'insert-after.webm',
      mimeType: clipPath.type,
      buffer: Buffer.from(clipPath.bytes),
    })
    await expect(tiles).toHaveCount(3, { timeout: 20_000 })
    expect(await tiles.nth(0).getAttribute('data-clip-id')).toBe(firstId)
    expect(await tiles.nth(2).getAttribute('data-clip-id')).toBe(secondId)
    await expect(tiles.nth(1)).toHaveClass(/selected/)
    expect(await tiles.nth(1).getAttribute('data-clip-id')).not.toBe(firstId)
    expect(await tiles.nth(1).getAttribute('data-clip-id')).not.toBe(secondId)
  })

  test('moving a clip with the arrow buttons keeps it in view', async ({ page }) => {
    await openEditorWithClips(page, 8, 8000)
    const tiles = page.locator('.clip-thumb[data-clip-id]')
    await expect(tiles).toHaveCount(8)
    await tiles.first().click()
    for (let i = 0; i < 6; i += 1) {
      await page.getByRole('button', { name: 'Move clip right' }).click()
    }
    const selected = tiles.nth(6)
    await expect(selected).toHaveClass(/selected/)
    await expect
      .poll(async () => {
        return selected.evaluate((el) => {
          const tile = el.getBoundingClientRect()
          const strip = el.closest('.timeline')?.getBoundingClientRect()
          if (!strip) return false
          return tile.left >= strip.left - 4 && tile.right <= strip.right + 4
        })
      })
      .toBe(true)
  })

  test('empty timeline offers Add clips from your device', async ({ page }) => {
    await openSeededProject(page, { clips: 0 })
    // openSeededProject with 0 clips still creates a project; open editor.
    await page.getByRole('button', { name: 'Open editor' }).click()
    await expect(page.locator('.editor-screen')).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Add clips from your device' }),
    ).toBeVisible()
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
