import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { gotoHome, saveScreenshot, totalClipCount, waitForCameraReady } from './helpers'

/** Audio-only fragmented MP4, the shape of the broken take Kent hit.
 * Regenerate: ffmpeg -f lavfi -i "sine=frequency=440:duration=2" -c:a aac
 *   -b:a 64k -movflags frag_keyframe+empty_moov+default_base_moof audio-only.mp4 */
const AUDIO_ONLY_MP4 = path.join(import.meta.dirname, '../fixtures/audio-only.mp4')

/** Good, audio-only, good: the audio-only take is Clip 2. */
async function seedProjectWithAudioOnlyClip(page: Page): Promise<string> {
  const audioOnlyBase64 = (await readFile(AUDIO_ONLY_MP4)).toString('base64')
  await gotoHome(page)
  return page.evaluate(async (base64) => {
    const storage = await import('/src/lib/storage.ts')
    const thumbs = await import('/src/lib/thumbs.ts')
    const { makeTestClipBlob } = await import('/src/lib/testing/make-test-clip.ts')
    const project = await storage.createProject()
    const good = await makeTestClipBlob(1500)
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    const first = await storage.addClip({
      projectId: project.id,
      blob: good,
      mimeType: 'video/webm',
      durationMs: 1500,
      width: 320,
      height: 568,
    })
    const withThumbs = await thumbs.ensureClipThumbs(first)
    const broken = await storage.addClip({
      projectId: project.id,
      blob: new Blob([bytes], { type: 'video/mp4;codecs=avc1.640028,mp4a.40.2' }),
      mimeType: 'video/mp4;codecs=avc1.640028,mp4a.40.2',
      durationMs: 2000,
      width: 1080,
      height: 1920,
    })
    // Real broken takes still have thumbs: they come from the live preview.
    if (withThumbs.thumbs?.length && withThumbs.poster) {
      await storage.updateClipThumbs(broken.id, {
        thumbs: withThumbs.thumbs,
        poster: withThumbs.poster,
        thumbWidth: withThumbs.thumbWidth ?? 90,
        thumbHeight: withThumbs.thumbHeight ?? 160,
      })
    }
    const last = await storage.addClip({
      projectId: project.id,
      blob: good,
      mimeType: 'video/webm',
      durationMs: 1500,
      width: 320,
      height: 568,
    })
    await thumbs.ensureClipThumbs(last)
    return project.id
  }, audioOnlyBase64)
}

test('export names a clip with no video, deletes it, and retries', async ({ page }, testInfo) => {
  const projectId = await seedProjectWithAudioOnlyClip(page)
  await page.goto(`/project/${projectId}`)
  await waitForCameraReady(page)

  // The filmstrip marks it before any export.
  await page.getByRole('button', { name: 'Open editor' }).click()
  await expect(page.locator('.editor-screen')).toBeVisible()
  const brokenTile = page.locator('.clip-thumb').nth(1)
  await expect(brokenTile.locator('.clip-broken-badge')).toHaveText('No video')
  await expect(brokenTile).toHaveAttribute('aria-label', /^Clip 2, .*, no video/)
  await expect(page.locator('.clip-broken-badge')).toHaveCount(1)

  await page.locator('.go-button').click()
  const sheet = page.locator('.export-sheet')
  await expect(sheet).toContainText('Export hit a snag')
  await expect(sheet.locator('.sheet-message.is-error')).toHaveText(
    "Clip 2 has no video and can't be exported.",
  )
  await expect(sheet.locator('.export-broken-clip')).toHaveCount(1)
  await expect(sheet.locator('.export-broken-clip')).toContainText('Clip 2')
  await expect(sheet.getByRole('button', { name: 'Try again' })).toHaveCount(0)

  // Let the sheet finish sliding in before the screenshots.
  await page.waitForTimeout(600)
  await page.emulateMedia({ colorScheme: 'light' })
  await saveScreenshot(page, testInfo, 'export-no-video-light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await saveScreenshot(page, testInfo, 'export-no-video-dark')
  await page.emulateMedia({ colorScheme: 'light' })

  await sheet.getByRole('button', { name: 'Delete clip 2 and export' }).click()
  await expect(page.locator('.toast')).toContainText('Clip 2 deleted')
  await expect(page.getByText('Done! Your video is ready')).toBeVisible({ timeout: 60_000 })
  expect(await totalClipCount(page)).toBe(2)
  await expect(page.locator('.clip-broken-badge')).toHaveCount(0)
})
