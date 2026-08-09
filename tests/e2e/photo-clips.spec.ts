import { test, expect, type Page } from '@playwright/test'
import { gotoHome, openSeededProject, unlockPlus, waitForCameraReady } from './helpers'

/** Tiny mono 16-bit PCM WAV for music-bed regression coverage. */
function makeWavFile(name: string, durationSec = 4) {
  const rate = 8000
  const samples = Math.round(durationSec * rate)
  const dataSize = samples * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(rate, 24)
  buffer.writeUInt32LE(rate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), 44 + i * 2)
  }
  return { name, mimeType: 'audio/wav', buffer }
}

/** 1×1 red PNG — enough for the picker import path (decode + thumbs). */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** Seed a project with one photo clip (in-page canvas PNG) and open it. */
async function seedPhotoProject(
  page: Page,
  options: { durationMs?: number; videoClips?: number } = {},
): Promise<string> {
  await gotoHome(page)
  const projectId = await page.evaluate(
    async ({ durationMs, videoClips }) => {
      const storage = await import('/src/lib/storage.ts')
      const thumbs = await import('/src/lib/thumbs.ts')
      const { makeTestImageBlob } = await import('/src/lib/testing/make-test-image.ts')
      const project = await storage.createProject('Photo project')
      if (videoClips > 0) {
        const { makeTestClipBlob } = await import('/src/lib/testing/make-test-clip.ts')
        const blob = await makeTestClipBlob(1500)
        for (let i = 0; i < videoClips; i += 1) {
          const clip = await storage.addClip({
            projectId: project.id,
            blob,
            mimeType: 'video/webm',
            durationMs: 1500,
            width: 320,
            height: 568,
          })
          await thumbs.ensureClipThumbs(clip)
        }
      }
      const photo = await storage.addClip({
        projectId: project.id,
        blob: await makeTestImageBlob(),
        mimeType: 'image/png',
        kind: 'image',
        durationMs,
        width: 320,
        height: 568,
        audioPeak: 0,
      })
      await thumbs.ensureClipThumbs(photo)
      return project.id
    },
    { durationMs: options.durationMs ?? 3000, videoClips: options.videoClips ?? 0 },
  )
  await page.goto(`/project/${projectId}`)
  await waitForCameraReady(page)
  return projectId
}

test.describe('photo clips on the timeline', () => {
  test('a picked photo lands on the timeline as a 3s still with a badge', async ({ page }) => {
    await openSeededProject(page, { clips: 1 })
    await page.getByRole('button', { name: 'Open editor' }).click()
    await expect(page.locator('.editor-screen')).toBeVisible()

    await page
      .locator('.editor-screen input[type="file"]')
      .setInputFiles({ name: 'vacation.png', mimeType: 'image/png', buffer: TINY_PNG })

    await expect(page.locator('.toast')).toContainText('Clip added')
    const tiles = page.locator('.clip-thumb')
    await expect(tiles).toHaveCount(2)
    const photoTile = page.locator('.clip-thumb.is-photo')
    await expect(photoTile).toHaveCount(1)
    await expect(photoTile.locator('.clip-photo-badge')).toBeVisible()
    await expect(photoTile.locator('.clip-dur')).toHaveText('3.0s')

    const stored = await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      const projects = await storage.listProjects()
      const clips = await storage.getClipMetasForProject(projects[0]!.id)
      const photo = clips.find((clip: { kind?: string }) => clip.kind === 'image')
      return photo
        ? { durationMs: photo.durationMs, trimEndMs: photo.trimEndMs, audioPeak: photo.audioPeak }
        : null
    })
    expect(stored).toEqual({ durationMs: 3000, trimEndMs: 3000, audioPeak: 0 })
  })

  test('the duration strip sets an exact on-screen time (lengthen past the original)', async ({
    page,
  }) => {
    await seedPhotoProject(page, { durationMs: 3000 })
    await page.getByRole('button', { name: 'Open editor' }).click()
    await expect(page.locator('.editor-screen')).toBeVisible()

    // The photo is selected (most recent) — the trim action reads Duration.
    await page.getByRole('button', { name: 'Set photo duration' }).click()
    const strip = page.locator('.image-duration-strip')
    await expect(strip).toBeVisible()
    await expect(strip).toContainText('3.0s on screen')

    // Preset for speed, steppers for exactness: 5s + 0.5 + 0.5 = 6.0s —
    // twice the original duration, something a video trim can never do.
    await strip.getByRole('button', { name: '5s', exact: true }).click()
    await strip.getByRole('button', { name: 'Lengthen by half a second' }).click()
    await strip.getByRole('button', { name: 'Lengthen by half a second' }).click()
    await expect(strip).toContainText('6.0s on screen')
    await strip.getByRole('button', { name: 'Done' }).click()
    await expect(strip).toBeHidden()

    await expect(page.locator('.clip-thumb .clip-dur').first()).toHaveText('6.0s')
    const stored = await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      const projects = await storage.listProjects()
      const clips = await storage.getClipMetasForProject(projects[0]!.id)
      return { durationMs: clips[0]!.durationMs, trimEndMs: clips[0]!.trimEndMs }
    })
    expect(stored).toEqual({ durationMs: 6000, trimEndMs: 6000 })
  })

  test('the duration handle drags to lengthen and shorten', async ({ page }) => {
    await seedPhotoProject(page, { durationMs: 3000 })
    await page.getByRole('button', { name: 'Open editor' }).click()
    await page.getByRole('button', { name: 'Set photo duration' }).click()
    const strip = page.locator('.image-duration-strip')
    await expect(strip).toBeVisible()

    // The track is a 0→30s scale; drag the handle to ~50% ≈ 15s.
    const handle = strip.getByRole('slider', { name: 'Photo duration handle' })
    const handleBox = await handle.boundingBox()
    const trackBox = await strip.locator('.trim-strip-track').boundingBox()
    if (!handleBox || !trackBox) throw new Error('duration geometry unavailable')
    const y = handleBox.y + handleBox.height / 2
    await page.mouse.move(handleBox.x + handleBox.width / 2, y)
    await page.mouse.down()
    await page.mouse.move(trackBox.x + trackBox.width * 0.5, y, { steps: 8 })
    await page.mouse.up()
    await strip.getByRole('button', { name: 'Done' }).click()

    const durationMs = await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      const projects = await storage.listProjects()
      const clips = await storage.getClipMetasForProject(projects[0]!.id)
      return clips[0]!.durationMs
    })
    expect(durationMs).toBeGreaterThan(12_000)
    expect(durationMs).toBeLessThan(18_000)
  })

  test('the duration handle is a keyboard-controllable slider', async ({ page }) => {
    await seedPhotoProject(page, { durationMs: 3000 })
    await page.getByRole('button', { name: 'Open editor' }).click()
    await page.getByRole('button', { name: 'Set photo duration' }).click()
    const strip = page.locator('.image-duration-strip')
    const handle = strip.getByRole('slider', { name: 'Photo duration handle' })
    await expect(handle).toHaveAttribute('aria-valuenow', '3')
    await handle.focus()
    await page.keyboard.press('ArrowRight')
    await expect(strip).toContainText('3.1s on screen')
    await page.keyboard.press('PageUp')
    await expect(strip).toContainText('4.1s on screen')
    await page.keyboard.press('Home')
    await expect(strip).toContainText('0.5s on screen')
    await page.keyboard.press('End')
    await expect(strip).toContainText('30.0s on screen')
  })

  test('photo-first preview starts the music bed once the audio element binds', async ({
    page,
  }) => {
    // Regression: startImage() used to call playMusic() before the <audio>
    // ref existed, so a film that opens on a photo stayed silent.
    const projectId = await seedPhotoProject(page, { durationMs: 5000 })
    // Unlock before re-entering the project so the editor renders the
    // unlocked Add music control (not the Plus upsell button).
    await unlockPlus(page)
    await page.goto(`/project/${projectId}`)
    await waitForCameraReady(page)
    await page.getByRole('button', { name: 'Open editor' }).click()
    await expect(page.locator('.editor-screen')).toBeVisible()

    const chooserPromise = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Add background music' }).click()
    const chooser = await chooserPromise
    await chooser.setFiles(makeWavFile('photo-bed.wav', 8))
    await expect(page.locator('.audio-track-name').filter({ hasText: 'photo-bed.wav' })).toBeVisible(
      { timeout: 15_000 },
    )

    await page.getByRole('button', { name: 'Play project preview' }).click()
    const overlay = page.locator('.playback-overlay')
    await expect(overlay).toBeVisible()
    await expect(page.locator('.playback-image')).toBeVisible()
    const music = overlay.locator('audio')
    await expect(music).toHaveCount(1)
    await expect
      .poll(() => music.evaluate((el) => !(el as HTMLAudioElement).paused), { timeout: 10_000 })
      .toBe(true)

    await overlay.getByRole('button', { name: 'Stop preview' }).click()
    await expect(overlay).toBeHidden()
  })

  test('project preview shows the photo for its duration, then finishes', async ({ page }) => {
    await seedPhotoProject(page, { durationMs: 1000 })
    await page.getByRole('button', { name: 'Open editor' }).click()
    await page.getByRole('button', { name: 'Play project preview' }).click()

    const overlay = page.locator('.playback-overlay')
    await expect(overlay).toBeVisible()
    await expect(page.locator('.playback-image')).toBeVisible()
    // The photo plays out on its wall-clock timer and the preview closes.
    await expect(overlay).toBeHidden({ timeout: 10_000 })
  })

  test('photos export into the stitched film at their chosen duration', async ({ page }) => {
    test.slow()
    await gotoHome(page)

    const measured = await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      const { exportProject } = await import('/src/lib/export/index.ts')
      const { makeTestClipBlob } = await import('/src/lib/testing/make-test-clip.ts')
      const { makeTestImageBlob } = await import('/src/lib/testing/make-test-image.ts')

      const project = await storage.createProject()
      await storage.addClip({
        projectId: project.id,
        blob: await makeTestClipBlob(1500),
        mimeType: 'video/webm',
        durationMs: 1500,
        width: 320,
        height: 568,
      })
      await storage.addClip({
        projectId: project.id,
        blob: await makeTestImageBlob(320, 568, '#c0396f'),
        mimeType: 'image/png',
        kind: 'image',
        durationMs: 2000,
        width: 320,
        height: 568,
        audioPeak: 0,
      })
      const clips = await storage.getClipsForProject(project.id)
      const result = await exportProject(clips, { watermark: false })

      // The exported audio track spans the whole film (photos contribute
      // silence), so its decoded length measures the output duration.
      const { decodeBackgroundAudio } = await import('/src/lib/export/shared.ts')
      const decoded = await decodeBackgroundAudio(result.blob, 48000)
      return {
        durationSec: decoded ? decoded.duration : null,
        mimeType: result.mimeType,
        bytes: result.blob.size,
      }
    })

    expect(measured.bytes).toBeGreaterThan(8_000)
    // 1.5s video + 2s photo ≈ 3.5s film (codec padding keeps this a sanity
    // bound, not an exact one).
    expect(measured.durationSec).not.toBeNull()
    expect(measured.durationSec!).toBeGreaterThan(3.3)
    expect(measured.durationSec!).toBeLessThan(3.8)
  })
})
