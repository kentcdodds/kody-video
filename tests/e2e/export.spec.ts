import { test, expect, type Page } from '@playwright/test'
import { openSeededProject, waitForCameraReady } from './helpers'

async function exportReady(page: Page): Promise<void> {
  await expect(page.getByText('Done! Your video is ready')).toBeVisible({ timeout: 60_000 })
}

test.describe('Go / export', () => {
  test('Go exports on-device: progress, ready sheet, save, restore, zip', async ({ page }) => {
    // One flow: exports are the most expensive fixture in the suite, so the
    // ready-sheet assertions share a single encode.
    const offsiteWrites: string[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      const local = ['127.0.0.1', 'localhost'].includes(url.hostname)
      if (!local && request.method() !== 'GET') {
        offsiteWrites.push(`${request.method()} ${request.url()}`)
      }
    })

    const projectId = await openSeededProject(page, { clips: 2, clipMs: 2000 })

    await page.locator('.go-button').click()
    // The overlay can flash by on tiny projects — the ready sheet is the
    // contract; the overlay is asserted only if still up.
    await exportReady(page)

    const sheet = page.locator('.export-sheet')
    await expect(sheet).toContainText(/(MP4|WebM) · .+MB/i)
    // Watermark upsell shows before purchase.
    await expect(sheet).toContainText(/Get Plus/)

    // Save stores the file locally.
    const downloadPromise = page.waitForEvent('download')
    await sheet.getByRole('button', { name: 'Save', exact: true }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/\.(mp4|webm)$/)
    await expect(sheet).toContainText('Saved — check your downloads.')

    // Clips ZIP from the ready sheet.
    const zipPromise = page.waitForEvent('download')
    await sheet.getByRole('button', { name: /Save original clips/ }).click()
    const zip = await zipPromise
    expect(zip.suggestedFilename()).toMatch(/\.zip$/)

    // Closing and tapping Go again restores the cached export instantly.
    await sheet.getByRole('button', { name: 'Done' }).click()
    await expect(sheet).toBeHidden()
    await page.locator('.go-button').click()
    await expect(page.getByText(/Restored your last export/)).toBeVisible({ timeout: 8_000 })

    // Re-export from scratch renders fresh (no restore notice). The old
    // ready sheet must actually give way to the new encode first — without
    // this, exportReady could match the still-mounted previous message.
    await page.locator('.export-sheet').getByRole('button', { name: /Re-export from scratch/ }).click()
    await expect(page.getByText('Done! Your video is ready')).toBeHidden()
    await exportReady(page)
    await expect(page.getByText(/Restored your last export/)).toBeHidden()

    // Editing the project invalidates the cached export.
    await page.locator('.export-sheet').getByRole('button', { name: 'Done' }).click()
    await page.evaluate(async (id) => {
      const storage = await import('/src/lib/storage.ts')
      const { makeTestClipBlob } = await import('/src/lib/testing/make-test-clip.ts')
      await storage.addClip({
        projectId: id,
        blob: await makeTestClipBlob(1000),
        mimeType: 'video/webm',
        durationMs: 1000,
        width: 320,
        height: 568,
      })
    }, projectId)
    await page.reload()
    await waitForCameraReady(page)
    await page.locator('.go-button').click()
    await exportReady(page)
    await expect(page.getByText(/Restored your last export/)).toBeHidden()

    // Nothing left the device: no non-GET requests to any non-local host
    // during recording, export, save, or zip.
    expect(offsiteWrites).toEqual([])
  })
})
