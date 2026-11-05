import { test, expect, type Page } from '@playwright/test'
import {
  gotoHome,
  openSeededProject,
  seedProject,
  unlockPlus,
  waitForCameraReady,
} from './helpers'

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
    const nameField = sheet.locator('#export-project-name')
    await expect(nameField).toHaveValue('Project 1')
    await expect(sheet).toContainText(/Saves as project-1\.(mp4|webm)/i)

    // Watermark upsell shows before purchase.
    await expect(sheet).toContainText(/Get Plus/)
    await expect(
      sheet.getByRole('checkbox', { name: /Include clip locations/ }),
    ).toHaveCount(0)

    // Save stores the file locally.
    const downloadPromise = page.waitForEvent('download')
    await sheet.getByRole('button', { name: 'Save', exact: true }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/^project-1\.(mp4|webm)$/)
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

    // Rename on the ready sheet so Share/Save use a better filename than
    // project-1. The file itself is unchanged until Re-export.
    const restoredSheet = page.locator('.export-sheet')
    const renameField = restoredSheet.locator('#export-project-name')
    await expect(renameField).toHaveValue('Project 1')
    await renameField.fill('Beach day')
    await expect(restoredSheet).toContainText(/Saves as beach-day\.(mp4|webm)/i)
    const renamedDownload = page.waitForEvent('download')
    await restoredSheet.getByRole('button', { name: 'Save', exact: true }).click()
    expect((await renamedDownload).suggestedFilename()).toMatch(/^beach-day\.(mp4|webm)$/)
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const storage = await import('/src/lib/storage.ts')
          return (await storage.listProjects())[0]?.name ?? null
        }),
      )
      .toBe('Beach day')

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

  test('export size presets shrink the file, are remembered, and still play', async ({
    page,
  }) => {
    await openSeededProject(page, { clips: 2, clipMs: 1500, size: { width: 720, height: 1280 } })
    await page.locator('.go-button').click()
    await exportReady(page)

    const sheet = page.locator('.export-sheet')
    const sizes = sheet.getByRole('radiogroup', { name: 'Export size' })
    // 720p film: 720p would not shrink it, so only Full and 480p are offered.
    await expect(sizes.getByRole('radio')).toHaveCount(2)
    await expect(sizes.getByRole('radio', { name: /Full/ })).toHaveAttribute('aria-checked', 'true')
    await expect(sizes.getByRole('radio', { name: /480p/ })).toContainText(/~[\d.]+ (KB|MB)/)

    // Picking a size re-exports at it right away.
    await sizes.getByRole('radio', { name: /480p/ }).click()
    await expect(page.getByText('Done! Your video is ready')).toBeHidden()
    await exportReady(page)
    await expect(sizes.getByRole('radio', { name: /480p/ })).toHaveAttribute('aria-checked', 'true')

    await expect
      .poll(() =>
        page.evaluate(async () => {
          const storage = await import('/src/lib/storage.ts')
          return (await storage.getSettings()).exportSize ?? null
        }),
      )
      .toBe('480p')
    // The recoverable copy on disk is the 480p render, not the earlier Full one.
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const storage = await import('/src/lib/storage.ts')
          const signature = (await storage.getSettings()).lastExport?.signature
          return signature ? (JSON.parse(signature).size ?? 'full') : null
        }),
      )
      .toBe('480p')

    // The saved file really is 480p and plays.
    const played = await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      const name = (await storage.getSettings()).lastExport?.opfsName
      if (!name) throw new Error('no last export')
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle('exports')
      const file = await (await dir.getFileHandle(name)).getFile()
      const video = document.createElement('video')
      video.muted = true
      video.src = URL.createObjectURL(file)
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve()
        video.onerror = () => reject(new Error('export failed to load'))
      })
      await video.play()
      await new Promise((resolve) => setTimeout(resolve, 300))
      const result = {
        width: video.videoWidth,
        height: video.videoHeight,
        advanced: video.currentTime > 0,
      }
      video.pause()
      URL.revokeObjectURL(video.src)
      return result
    })
    expect(played).toEqual({ width: 480, height: 854, advanced: true })

    // The remembered size applies to the next Go and keeps the cache keyed to it.
    await sheet.getByRole('button', { name: 'Done' }).click()
    await page.reload()
    await waitForCameraReady(page)
    await page.locator('.go-button').click()
    await expect(page.getByText(/Restored your last export/)).toBeVisible({ timeout: 8_000 })
    await expect(
      page.locator('.export-sheet').getByRole('radio', { name: /480p/ }),
    ).toHaveAttribute('aria-checked', 'true')
  })

  test('format choice: MP4 (H.264 + AAC) by default, WebM on request, remembered', async ({
    page,
  }) => {
    await openSeededProject(page, { clips: 2, clipMs: 1500 })
    await page.locator('.go-button').click()
    await exportReady(page)

    const sheet = page.locator('.export-sheet')
    const formats = sheet.getByRole('radiogroup', { name: 'Export format' })
    await expect(formats.getByRole('radio', { name: 'MP4' })).toHaveAttribute('aria-checked', 'true')
    await expect(sheet).toContainText(/MP4 · .+B/)
    await expect(sheet).toContainText(/Saves as project-1\.mp4/)

    const inspectLastExport = () =>
      page.evaluate(async () => {
        const storage = await import('/src/lib/storage.ts')
        const name = (await storage.getSettings()).lastExport?.opfsName
        if (!name) throw new Error('no last export')
        const root = await navigator.storage.getDirectory()
        const dir = await root.getDirectoryHandle('exports')
        const file = await (await dir.getFileHandle(name)).getFile()
        const bytes = new Uint8Array(await file.arrayBuffer())
        const ascii = new TextDecoder('latin1').decode(bytes)
        const ebml = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
        const video = document.createElement('video')
        video.muted = true
        video.src = URL.createObjectURL(file)
        await new Promise<void>((resolve, reject) => {
          video.onloadedmetadata = () => resolve()
          video.onerror = () => reject(new Error('export failed to load'))
        })
        await video.play()
        await new Promise((resolve) => setTimeout(resolve, 300))
        const advanced = video.currentTime > 0
        video.pause()
        URL.revokeObjectURL(video.src)
        return {
          container: ascii.slice(4, 8) === 'ftyp' ? 'mp4' : ebml ? 'webm' : 'unknown',
          h264: ascii.includes('avcC'),
          aac: ascii.includes('mp4a'),
          opus: ascii.includes('A_OPUS'),
          advanced,
        }
      })

    expect(await inspectLastExport()).toEqual({
      container: 'mp4',
      h264: true,
      aac: true,
      opus: false,
      advanced: true,
    })

    // Picking WebM re-exports in it right away, and the choice is remembered.
    await formats.getByRole('radio', { name: 'WebM' }).click()
    await expect(page.getByText('Done! Your video is ready')).toBeHidden()
    await exportReady(page)
    await expect(formats.getByRole('radio', { name: 'WebM' })).toHaveAttribute('aria-checked', 'true')
    await expect(sheet).toContainText(/Saves as project-1\.webm/)
    expect(await inspectLastExport()).toMatchObject({ container: 'webm', opus: true, advanced: true })
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const storage = await import('/src/lib/storage.ts')
          const settings = await storage.getSettings()
          const signature = settings.lastExport?.signature
          return [settings.exportFormat, signature ? JSON.parse(signature).format : null]
        }),
      )
      .toEqual(['webm', 'webm'])

    // Back to MP4 after a reload: the WebM cache is not reused for an MP4 Go.
    await sheet.getByRole('button', { name: 'Done' }).click()
    await page.reload()
    await waitForCameraReady(page)
    await page.locator('.go-button').click()
    await expect(page.getByText(/Restored your last export/)).toBeVisible({ timeout: 8_000 })
    await expect(formats.getByRole('radio', { name: 'WebM' })).toHaveAttribute('aria-checked', 'true')
    await formats.getByRole('radio', { name: 'MP4' }).click()
    await expect(page.getByText('Done! Your video is ready')).toBeHidden()
    await exportReady(page)
    await expect(sheet).toContainText(/Saves as project-1\.mp4/)
    expect(await inspectLastExport()).toMatchObject({ container: 'mp4', aac: true, advanced: true })
  })

  test('browsers without an H.264 encoder export WebM and say so', async ({ page }) => {
    await page.addInitScript(() => {
      const original = VideoEncoder.isConfigSupported.bind(VideoEncoder)
      VideoEncoder.isConfigSupported = async (config) =>
        /^(avc|hvc|hev)/.test(config.codec) ? { supported: false, config } : original(config)
    })
    await openSeededProject(page, { clips: 1, clipMs: 1500 })
    await page.locator('.go-button').click()
    await exportReady(page)

    const sheet = page.locator('.export-sheet')
    const formats = sheet.getByRole('radiogroup', { name: 'Export format' })
    await expect(formats.getByRole('radio', { name: 'MP4' })).toBeDisabled()
    await expect(formats.getByRole('radio', { name: 'WebM' })).toHaveAttribute('aria-checked', 'true')
    await expect(sheet).toContainText('This browser can’t encode H.264, so exports are WebM.')
    await expect(sheet).toContainText(/Saves as project-1\.webm/)
  })

  test('Stop cancels an in-flight export without waiting for the file', async ({ page }) => {
    await openSeededProject(page, { clips: 3, clipMs: 4000 })
    await page.locator('.go-button').click()
    const overlay = page.getByRole('dialog', { name: 'Exporting video' })
    await expect(overlay).toBeVisible({ timeout: 10_000 })
    await overlay.getByRole('button', { name: 'Stop export' }).click()
    await expect(overlay).toBeHidden()
    await expect(page.getByText('Done! Your video is ready')).toBeHidden()
    await expect(page.locator('.go-button')).toBeVisible()
  })

  test('Plus users can change mark and location settings during export', async ({ page }) => {
    const projectId = await seedProject(page, {
      clips: 3,
      clipMs: 4000,
      location: { lat: 40.41791, lng: -111.81496 },
    })
    await unlockPlus(page)
    await page.goto(`/project/${projectId}`)
    await waitForCameraReady(page)

    await page.locator('.go-button').click()
    const overlay = page.getByRole('dialog', { name: 'Exporting video' })
    await expect(overlay).toBeVisible({ timeout: 10_000 })
    const markToggle = overlay.getByRole('checkbox', { name: 'Keep the Kody mark on exports' })
    const locationToggle = overlay.getByRole('checkbox', {
      name: 'Include clip locations in MP4 exports',
    })
    await expect(markToggle).toBeVisible()
    await expect(locationToggle).toBeVisible()
    await expect(markToggle).not.toBeChecked()
    await expect(locationToggle).not.toBeChecked()
    await locationToggle.check()
    await expect(overlay).toContainText(/includes clip locations/i)
    await overlay.getByRole('button', { name: 'Stop export' }).click()
    await expect(overlay).toBeHidden()
  })

  test('Plus users can opt location metadata into future MP4 exports', async ({ page }) => {
    const projectId = await seedProject(page, {
      clips: 1,
      clipMs: 800,
      location: { lat: 40.41791, lng: -111.81496 },
    })
    await unlockPlus(page)
    await page.goto(`/project/${projectId}`)
    await waitForCameraReady(page)

    await page.locator('.go-button').click()
    await exportReady(page)

    const sheet = page.locator('.export-sheet')
    const locationToggle = sheet.getByRole('checkbox', {
      name: 'Include clip locations in MP4 exports',
    })
    await expect(locationToggle).toBeVisible()
    await expect(locationToggle).not.toBeChecked()
    await expect(sheet).toContainText('Location is off by default')

    await locationToggle.check()
    await expect(locationToggle).toBeChecked()
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
