import { test, expect, type Page } from '@playwright/test'
import {
  openNewProject,
  pressStageUntilRecording,
  recordClip,
  totalClipCount,
  waitForCameraReady,
} from './helpers'

test.describe('camera & hold-to-record', () => {
  test('allow shows a live preview; hold records a clip and creates the project', async ({
    page,
  }) => {
    await openNewProject(page)
    await expect(page.locator('.hold-hint')).toContainText(/hold anywhere/i)

    await recordClip(page)
    // Lazy creation: the first take flips /project/new to the real id.
    await page.waitForURL((url) => !url.pathname.endsWith('/project/new'))
    const projects = await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      return (await storage.listProjects()).length
    })
    expect(projects).toBe(1)

    // A second hold appends to the same project.
    await recordClip(page)
    expect(await totalClipCount(page)).toBe(2)

    // Takes carry a poster/thumb captured from the LIVE preview — decoding
    // the fresh blob behind the running camera is the post-take black
    // flash, so the loader backfill must find nothing left to generate.
    // EXACTLY one frame proves the live-capture path persisted them: the
    // decode-based backfill generates THUMB_COUNT (3) frames, so this
    // assertion fails if capture broke and the backfill covered for it.
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const storage = await import('/src/lib/storage.ts')
            const projects = await storage.listProjects()
            const clips = await storage.getClipsForProject(projects[0]!.id)
            return clips.map((clip: { thumbs?: Blob[]; poster?: Blob }) => ({
              thumbs: clip.thumbs?.length ?? 0,
              poster: !!clip.poster,
            }))
          }),
        { timeout: 10_000 },
      )
      .toEqual([
        { thumbs: 1, poster: true },
        { thumbs: 1, poster: true },
      ])

    // The poster must carry a real camera frame — a black poster means the
    // capture path (the detached mirror element) never delivered pixels.
    const posterLuma = await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      const projects = await storage.listProjects()
      const clips = await storage.getClipsForProject(projects[0]!.id)
      const bitmap = await createImageBitmap(clips[0]!.poster as Blob)
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      let sum = 0
      for (let i = 0; i < data.length; i += 4) {
        sum += 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!
      }
      return sum / (data.length / 4)
    })
    expect(posterLuma).toBeGreaterThan(8)
  })

  test('recording shows the REC pill with elapsed time', async ({ page }) => {
    await openNewProject(page)
    await pressStageUntilRecording(page)
    const pill = page.locator('.record-pill')
    await expect(pill).toContainText('REC')
    await expect(pill.locator('.record-elapsed')).toContainText(/\d+\.\ds/)
    await page.mouse.up()
    await expect(pill).toBeHidden()
  })

  test('a very short tap does not create an empty clip', async ({ page }) => {
    await openNewProject(page)
    const stage = page.locator('.record-stage')
    const box = await stage.boundingBox()
    if (!box) throw new Error('no stage')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(30)
    await page.mouse.up()
    await expect(page.locator('.toast')).toContainText('Hold a bit longer')
    expect(await totalClipCount(page)).toBe(0)
  })

  test('delete last clip offers Undo, and Undo restores it', async ({ page }) => {
    await openNewProject(page)
    await recordClip(page)
    await page.getByRole('button', { name: 'Delete last clip' }).click()
    await expect(page.locator('.toast')).toContainText('Last clip deleted')
    expect(await totalClipCount(page)).toBe(0)
    await page.locator('.toast').getByRole('button', { name: 'Undo' }).click()
    await expect(page.locator('.toast')).toContainText('Clip restored')
    expect(await totalClipCount(page)).toBe(1)
  })

  test('self-timer counts down and records hands-free until tapped', async ({ page }) => {
    await openNewProject(page)
    await page.getByRole('button', { name: 'Self-timer' }).click()
    await expect(page.locator('.countdown-overlay')).toBeVisible()
    const pill = page.locator('.record-pill')
    await expect(pill).toContainText('TAP TO STOP', { timeout: 15_000 })
    await page.waitForTimeout(700)
    const stage = page.locator('.record-stage')
    await stage.click({ position: { x: 100, y: 200 } })
    await expect.poll(() => totalClipCount(page), { timeout: 15_000 }).toBe(1)
  })

  test('denied camera shows the permission panel with retry', async ({ browser }) => {
    const context = await browser.newContext()
    await context.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
    })
    const page = await context.newPage()
    await page.goto('/')
    await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      await storage.setOnboardingDismissed(true)
    })
    await page.getByRole('button', { name: 'New project', exact: true }).click()
    const panel = page.locator('.permission-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('Camera access')
    await expect(panel.getByRole('button', { name: 'Try again' })).toBeVisible()
    await context.close()
  })

  test('location tagging geotags new clips while on', async ({ context, page }) => {
    await context.grantPermissions(['camera', 'microphone', 'geolocation'])
    await context.setGeolocation({ latitude: 40.2338, longitude: -111.6585, accuracy: 12 })
    await openNewProject(page)
    const toggle = page.getByRole('button', { name: 'Toggle location tagging' })
    await toggle.click()
    await expect(page.locator('.toast')).toContainText('Location tagging on')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')

    await recordClip(page)
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const storage = await import('/src/lib/storage.ts')
            const projects = await storage.listProjects()
            if (projects.length === 0) return null
            const clips = await storage.getClipMetasForProject(projects[0]!.id)
            const clip = clips[0] as { lat?: number; lng?: number } | undefined
            return clip?.lat != null && clip?.lng != null
              ? { lat: clip.lat, lng: clip.lng }
              : null
          }),
        { timeout: 15_000 },
      )
      .toEqual({ lat: 40.2338, lng: -111.6585 })
  })
})

test.describe('camera resume after suspension', () => {
  const activeTrackId = (page: Page) =>
    page.evaluate(() => {
      const video = document.querySelector<HTMLVideoElement>('.camera-video')
      const stream = video?.srcObject as MediaStream | null
      const track = stream?.getVideoTracks()[0]
      return track && track.readyState === 'live' ? track.id : null
    })

  test('resuming without a visible transition restarts the camera (iOS PWA)', async ({
    page,
  }) => {
    await openNewProject(page)

    // Phone off / app closed: the page reports hidden, the camera stops.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect
      .poll(() =>
        page.evaluate(
          () => document.querySelector<HTMLVideoElement>('.camera-video')?.srcObject === null,
        ),
      )
      .toBe(true)

    // Phone back on: iOS Safari (installed PWAs especially) resumes with
    // focus/pageshow only — no visibilitychange ever fires.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
      window.dispatchEvent(new Event('focus'))
    })
    await waitForCameraReady(page)
    expect(await activeTrackId(page)).not.toBe(null)
  })

  test('a dead camera track on refocus restarts the preview', async ({ page }) => {
    await openNewProject(page)
    const staleTrackId = await page.evaluate(() => {
      const video = document.querySelector<HTMLVideoElement>('.camera-video')!
      const track = (video.srcObject as MediaStream).getVideoTracks()[0]!
      // The OS killed the camera while the app was suspended.
      track.stop()
      return track.id
    })

    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => activeTrackId(page), { timeout: 15_000 }).not.toBe(null)
    expect(await activeTrackId(page)).not.toBe(staleTrackId)
    await waitForCameraReady(page)
  })

  test('window focus with a healthy preview does not restart the camera', async ({ page }) => {
    await openNewProject(page)
    const before = await activeTrackId(page)
    expect(before).not.toBe(null)

    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.waitForTimeout(600)
    expect(await activeTrackId(page)).toBe(before)
  })
})
