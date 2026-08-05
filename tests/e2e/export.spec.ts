import { test, expect, type Page } from '@playwright/test'
import { gotoHome, openSeededProject, waitForCameraReady } from './helpers'

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

    // Cache hygiene: exactly ONE recoverable export remains on disk after a
    // boot sweep — no stray temp files, no zip scratch, no duplicate copy of
    // the export (the double-store was how "storage full" survived deleting
    // every project).
    await page.locator('.export-sheet').getByRole('button', { name: 'Done' }).click()
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const storage = await import('/src/lib/storage.ts')
          return (await storage.getSettings()).lastExport?.opfsName ?? null
        }),
      )
      .not.toBeNull()
    await page.reload()
    await waitForCameraReady(page)
    const cacheEntries = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle('exports', { create: true })
      const names: string[] = []
      for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
        names.push(name)
      }
      return names
    })
    expect(cacheEntries).toHaveLength(1)
  })

  test('adjacent clips crossfade audio at the joint instead of dipping to silence', async ({
    page,
  }) => {
    test.slow()
    await gotoHome(page)

    const measured = await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      const { exportProject } = await import('/src/lib/export/index.ts')
      const { decodeBackgroundAudio } = await import('/src/lib/export/shared.ts')
      const { makeTestClipBlob } = await import('/src/lib/testing/make-test-clip.ts')

      // Two clips carrying steady sine tones at DIFFERENT frequencies: the
      // joint between them is exactly where the old per-slice fade-to-zero
      // produced an audible dip to silence.
      const project = await storage.createProject()
      for (const toneHz of [440, 880]) {
        await storage.addClip({
          projectId: project.id,
          blob: await makeTestClipBlob(2000, toneHz),
          mimeType: 'video/webm',
          durationMs: 2000,
          width: 320,
          height: 568,
        })
      }
      const clips = await storage.getClipsForProject(project.id)
      const result = await exportProject(clips, { watermark: false })

      const decoded = await decodeBackgroundAudio(result.blob, 48000)
      if (!decoded) return null
      const data = decoded.getChannelData(0)
      const rms = (fromSec: number, toSec: number) => {
        const from = Math.max(0, Math.floor(fromSec * decoded.sampleRate))
        const to = Math.min(Math.floor(toSec * decoded.sampleRate), data.length)
        let sum = 0
        for (let i = from; i < to; i += 1) sum += data[i]! * data[i]!
        return Math.sqrt(sum / Math.max(1, to - from))
      }
      // Dominant frequency proxy: sign changes per second (~2× frequency).
      const crossingsPerSec = (fromSec: number, toSec: number) => {
        const from = Math.max(1, Math.floor(fromSec * decoded.sampleRate))
        const to = Math.min(Math.floor(toSec * decoded.sampleRate), data.length)
        let crossings = 0
        for (let i = from; i < to; i += 1) {
          if (data[i - 1]! < 0 !== data[i]! < 0) crossings += 1
        }
        return crossings / Math.max(0.001, toSec - fromSec)
      }
      // The video cut sits at 2s − CROSSFADE_HALF_MS on the output
      // timeline; scan 2ms windows across the whole joint region (which
      // also covers 2.0s, where the OLD dip landed) for the quietest spot.
      const jointSec = 1.99
      let jointMin = Number.POSITIVE_INFINITY
      for (let t = jointSec - 0.04; t <= jointSec + 0.04; t += 0.001) {
        jointMin = Math.min(jointMin, rms(t - 0.001, t + 0.001))
      }
      return {
        durationSec: decoded.duration,
        clipA: rms(0.8, 1.6),
        clipB: rms(2.4, 3.2),
        clipAFreq: crossingsPerSec(0.8, 1.6) / 2,
        clipBFreq: crossingsPerSec(2.4, 3.2) / 2,
        jointMin,
      }
    })

    expect(measured).not.toBeNull()
    // Both clips' own audio made it through, in order.
    expect(measured!.clipAFreq).toBeGreaterThan(340)
    expect(measured!.clipAFreq).toBeLessThan(540)
    expect(measured!.clipBFreq).toBeGreaterThan(700)
    expect(measured!.clipBFreq).toBeLessThan(1060)
    expect(measured!.clipA).toBeGreaterThan(0.1)
    expect(measured!.clipB).toBeGreaterThan(0.1)
    // THE crossfade contract: the joint never dips toward silence. The old
    // fade-to-zero read ≈0.2× of the surrounding level here; the
    // equal-power overlap holds ≈1×.
    expect(measured!.jointMin).toBeGreaterThan(
      Math.min(measured!.clipA, measured!.clipB) * 0.6,
    )
    // Each joint trades CROSSFADE_MS of timeline for the overlap (codec
    // padding keeps this a sanity bound, not an exact one).
    expect(measured!.durationSec).toBeGreaterThan(3.9)
    expect(measured!.durationSec).toBeLessThan(4.05)
  })
})
