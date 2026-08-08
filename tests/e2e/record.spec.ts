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

  test('mid-take re-renders never blank the REC timer or zoom HUD', async ({ page }) => {
    // The fake camera exposes no zoom range — shim one in so drag-to-zoom
    // (and its HUD) engages like on a real phone.
    await page.addInitScript(() => {
      const original = MediaStreamTrack.prototype.getCapabilities
      MediaStreamTrack.prototype.getCapabilities = function () {
        const caps = (original ? original.call(this) : {}) as MediaTrackCapabilities &
          Record<string, unknown>
        if (this.kind === 'video') {
          caps.zoom = { min: 1, max: 8, step: 0.1 }
        }
        return caps
      }
    })
    await openNewProject(page)
    await pressStageUntilRecording(page)

    // Regression guard: both readouts update their text imperatively. A
    // re-render while recording used to bulk-clear them (the reconciler
    // wipes children of childless vnodes), collapsing the pills — visible
    // jitter. Record every mutation that leaves either readout empty.
    await page.evaluate(() => {
      const empties: string[] = []
      const watch = (selector: string) => {
        const el = document.querySelector(selector)
        if (!el) {
          empties.push(`${selector} missing`)
          return
        }
        const observer = new MutationObserver(() => {
          if ((el.textContent ?? '').trim() === '') empties.push(selector)
        })
        observer.observe(el, { childList: true, characterData: true, subtree: true })
      }
      watch('.record-pill .record-elapsed')
      watch('.zoom-hud')
      ;(window as Window & { __emptyTextEvents?: string[] }).__emptyTextEvents = empties
    })

    // Drift past the drag-zoom dead zone, then jiggle like a real thumb.
    const box = await page.locator('.record-stage').boundingBox()
    if (!box) throw new Error('no stage')
    const centerX = box.x + box.width / 2
    const centerY = box.y + box.height / 2
    await page.mouse.move(centerX, centerY - 40, { steps: 8 })
    const hud = page.locator('.zoom-hud')
    await expect(hud).toHaveClass(/is-visible/)
    await expect(hud).toHaveText(/\d(\.\d)?×/)
    for (let i = 0; i < 14; i += 1) {
      await page.mouse.move(centerX + (i % 2 ? 2 : -2), centerY - 40 - (i % 3), { steps: 2 })
      await page.waitForTimeout(250)
    }

    // The fake mic is silent, so the warning re-renders the screen mid-take —
    // proof the take actually survived at least one re-render.
    await expect(page.locator('.record-screen')).toContainText(/mic isn/i, {
      timeout: 10_000,
    })
    await expect(page.locator('.record-pill .record-elapsed')).toHaveText(/\d+\.\ds/)
    await expect(hud).toHaveText(/\d(\.\d)?×/)
    const emptyEvents = await page.evaluate(
      () => (window as Window & { __emptyTextEvents?: string[] }).__emptyTextEvents,
    )
    expect(emptyEvents).toEqual([])
    await page.mouse.up()
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
    await page.locator('.project-slot.empty').first().click()
    const panel = page.locator('.permission-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('Camera access')
    await expect(panel.getByRole('button', { name: 'Try again' })).toBeVisible()
    await context.close()
  })

  test('long toasts stay on screen, centered and wrapped', async ({ page }) => {
    // No geolocation permission granted: toggling location tagging surfaces
    // the longest toast in the app ("Location unavailable — check the site's
    // location permission"). It used to be anchored at mid-screen and cut
    // off by the right viewport edge (the rise-in animation's transform
    // replaced the centering translateX).
    await openNewProject(page)
    await page.getByRole('button', { name: 'Toggle location tagging' }).click()

    const toast = page.locator('.toast')
    await expect(toast).toContainText(
      "Location unavailable — check the site's location permission",
    )
    // The long message really wraps inside the pill instead of overflowing
    // it on a single line: the message box is at least two line-heights tall.
    // (getClientRects can't count line boxes here — a flex-item span is
    // blockified and reports a single rect.)
    const lines = await toast.locator('span').evaluate((el) => {
      const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight)
      return el.getBoundingClientRect().height / lineHeight
    })
    // ≥ 1.5 line-heights = wrapped (sub-pixel rounding keeps an exact two
    //-line box a hair under 2.0).
    expect(lines).toBeGreaterThan(1.5)
    const box = await toast.boundingBox()
    const viewport = page.viewportSize()
    expect(box).not.toBeNull()
    expect(viewport).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width)
    // Centered in the screen it is positioned against (the viewport can be
    // wider by a classic scrollbar in headless runs).
    const screen = await page.locator('.project-screen').boundingBox()
    expect(screen).not.toBeNull()
    const offCenter = Math.abs(box!.x + box!.width / 2 - (screen!.x + screen!.width / 2))
    expect(offCenter).toBeLessThanOrEqual(2)
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
