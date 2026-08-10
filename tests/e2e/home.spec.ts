import { test, expect } from '@playwright/test'
import { gotoHome, openNewProject, recordClip, unlockPlus } from './helpers'

test.describe('home & app shell', () => {
  test('landscape home is a deliberate two-pane layout; portrait keeps the column', async ({
    page,
  }) => {
    await gotoHome(page)

    // Portrait phone: classic column — hero above the 2-wide slot grid,
    // phone-shaped shell.
    const heroPortrait = await page.locator('.home-hero').boundingBox()
    const slotsPortrait = await page.locator('.project-slots').boundingBox()
    expect(heroPortrait).not.toBeNull()
    expect(slotsPortrait).not.toBeNull()
    expect(slotsPortrait!.y).toBeGreaterThan(heroPortrait!.y + heroPortrait!.height - 2)
    expect(await page.evaluate(() => document.documentElement.dataset.shell)).toBe('adaptive')
    expect((await page.locator('#root').boundingBox())!.width).toBeLessThanOrEqual(480)

    // Turned sideways: the shell widens and the hero moves into its own
    // left pane beside the slots (now 3 across).
    const viewport = page.viewportSize()!
    await page.setViewportSize({ width: viewport.height, height: viewport.width })
    // Polled: which element paints the hero is a render-time decision, so
    // the panes land a frame after the resize, not with it.
    await expect
      .poll(async () => {
        const hero = await page.locator('.home-hero').boundingBox()
        const slots = await page.locator('.project-slots').boundingBox()
        if (!hero || !slots) return false
        return slots.x > hero.x + hero.width - 2
      })
      .toBe(true)
    // The REAL hero art must render here: portrait mobile shows a spacer
    // (the static #boot-hero paints the LCP art), and rotating must swap in
    // the in-app image — a stale spacer is a blank square.
    await expect(page.locator('.home-hero img')).toBeVisible()
    expect((await page.locator('#root').boundingBox())!.width).toBeGreaterThan(600)
    const firstRow = await page.evaluate(() => {
      const tiles = [...document.querySelectorAll('.project-slot')]
      const top = Math.min(...tiles.map((tile) => tile.getBoundingClientRect().top))
      return tiles.filter((tile) => Math.abs(tile.getBoundingClientRect().top - top) < 2).length
    })
    expect(firstRow).toBe(3)

    // Prose pages center a readable column inside the wide shell.
    await page.goto('/about')
    const about = await page.locator('.about-screen').boundingBox()
    expect(about).not.toBeNull()
    expect(about!.width).toBeLessThanOrEqual(760)
  })

  test('onboarding shows on first camera open, dismisses for good', async ({ page }) => {
    await page.goto('/')
    await page.locator('.project-slot.empty').first().click()
    const overlay = page.locator('.onboarding-overlay')
    await expect(overlay).toBeVisible()
    await expect(overlay).toContainText('Hold to record')
    await expect(overlay).toContainText('Tap Go')
    await page.getByRole('button', { name: 'Start recording' }).click()
    await expect(overlay).toBeHidden()

    await page.reload()
    await expect(page.locator('.record-stage')).toBeVisible()
    await expect(page.locator('.onboarding-overlay')).toBeHidden()
  })

  test('first-timer tour card plays the tour and dismisses for good', async ({ page }) => {
    await page.goto('/')
    const card = page.locator('.tour-card')
    await expect(card).toBeVisible()

    // Teaser opens a top-layer <dialog> playing from media.kody.video —
    // the page layout underneath must not reflow while it plays.
    const slots = page.locator('.project-slots')
    await expect(slots).toBeVisible()
    const slotsBox = await slots.boundingBox()
    expect(slotsBox).not.toBeNull()
    const teaser = card.getByRole('button', { name: /watch the tour/i })
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    await teaser.click()
    const dialog = page.locator('dialog.tour-dialog')
    await expect(dialog).toBeVisible()
    // Second activation while open: dispatch on the teaser so we don't hit
    // the modal backdrop (a physical dblclick can after showModal() inerting).
    await teaser.dispatchEvent('click')
    await expect(dialog).toBeVisible()
    expect(pageErrors.filter((m) => /showModal|InvalidStateError/i.test(m))).toEqual([])
    const video = dialog.locator('video.tour-dialog-video')
    await expect(video).toHaveAttribute('src', /^https:\/\/media\.kody\.video\//)
    // The tap itself must start playback (in-gesture play() is what mobile
    // autoplay policies require) — rendered state alone can't prove that.
    // Generous timeout: the video streams over the real network and the
    // parallel suite competes for bandwidth.
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime), { timeout: 20_000 })
      .toBeGreaterThan(0)
    expect(await slots.boundingBox()).toEqual(slotsBox)

    // Esc closes the dialog and stops the audio.
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.paused))
      .toBe(true)
    await expect(teaser).toBeVisible()

    // Dismissal persists across SPA navigation (cached home data) …
    await card.getByRole('button', { name: 'Dismiss tour' }).click()
    await expect(card).toBeHidden()
    await page.getByRole('link', { name: 'About Kody Video' }).click()
    await expect(page.locator('.about-screen')).toBeVisible()
    await page.goBack()
    await expect(page.locator('.project-slots')).toBeVisible()
    await expect(page.locator('.tour-card')).toBeHidden()

    // … and across full reloads (persisted meta).
    await page.reload()
    await expect(page.locator('.project-slots')).toBeVisible()
    await expect(page.locator('.tour-card')).toBeHidden()
  })

  test('footer shows privacy line with a tappable storage gauge', async ({ page }) => {
    await gotoHome(page)
    const footer = page.locator('.home-privacy')
    await expect(footer).toContainText('Clips stay on this phone until you share.')
    const popover = page.locator('.storage-popover')
    await expect(popover).toBeHidden()
    await page.locator('.storage-meter').click()
    await expect(popover).toBeVisible()
    await expect(popover).toContainText(/of .+ used/)
    await page.keyboard.press('Escape')
    await expect(popover).toBeHidden()
  })

  test('free plan locks slots 2-6 behind the Plus upsell', async ({ page }) => {
    await gotoHome(page)
    await expect(page.locator('.project-slot.empty.locked')).toHaveCount(5)
    await page.locator('.project-slot.empty.locked').first().click()
    const upsell = page.getByRole('dialog', { name: 'Kody Video Plus' })
    await expect(upsell).toBeVisible()
    await expect(upsell).toContainText('The free plan includes 1 project')
    await expect(upsell.getByRole('button', { name: /Get Plus/ })).toBeVisible()
    await expect(upsell.getByRole('button', { name: /Already paid/ })).toBeVisible()
    await upsell.getByRole('button', { name: 'Not now' }).click()
    await expect(upsell).toBeHidden()
  })

  test('Plus unlocks 6 projects; the 7th is blocked', async ({ page }) => {
    await gotoHome(page)
    await unlockPlus(page)
    const outcome = await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      // Explicit names (even default-shaped ones): only projects still
      // carrying their GENERATED name are auto-deleted on home load.
      for (let i = 1; i <= 6; i += 1) {
        await storage.createProject(`Project ${i}`)
      }
      try {
        await storage.createProject('One too many')
        return 'created'
      } catch (error) {
        return error instanceof Error ? error.message : 'threw'
      }
    })
    expect(outcome).toContain('Project limit reached (6)')
    await page.reload()
    await expect(page.locator('.project-slot.filled')).toHaveCount(6)
    await expect(page.locator('.project-slot.empty.locked')).toHaveCount(0)
  })

  test('storage banner appears at 80% and turns critical at 92%', async ({ browser }) => {
    for (const [usedFraction, critical] of [
      [0.85, false],
      [0.95, true],
    ] as const) {
      const context = await browser.newContext()
      await context.addInitScript((fraction) => {
        const fake = async () => ({ usage: fraction * 1e9, quota: 1e9 })
        Object.defineProperty(navigator.storage, 'estimate', { value: fake })
      }, usedFraction)
      const page = await context.newPage()
      await page.goto('/')
      const banner = page.locator('.storage-banner')
      await expect(banner).toBeVisible()
      if (critical) {
        await expect(banner).toHaveClass(/is-critical/)
      } else {
        await expect(banner).not.toHaveClass(/is-critical/)
      }
      await context.close()
    }
  })

  test('theme follows prefers-color-scheme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/')
    const readBg = () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      )
    const lightBg = await readBg()
    await page.emulateMedia({ colorScheme: 'dark' })
    const darkBg = await readBg()
    expect(lightBg).not.toBe('')
    expect(darkBg).not.toBe('')
    expect(darkBg).not.toBe(lightBg)
  })

  test('document metas: full-bleed iOS, theme colors, social card', async ({ page }) => {
    await page.goto('/')
    const meta = (name: string, attr = 'name') =>
      page.locator(`meta[${attr}="${name}"]`).first()
    await expect(meta('viewport')).toHaveAttribute('content', /viewport-fit=cover/)
    await expect(meta('apple-mobile-web-app-status-bar-style')).toHaveAttribute(
      'content',
      'black-translucent',
    )
    await expect(meta('apple-mobile-web-app-capable')).toHaveAttribute('content', 'yes')
    await expect(page.locator('meta[name="theme-color"]')).toHaveCount(2)
    await expect(meta('og:image', 'property')).toHaveAttribute(
      'content',
      'https://kody.video/og-image.png',
    )
    await expect(meta('twitter:card')).toHaveAttribute('content', 'summary_large_image')
  })

  test('camera inspector reports what the browser exposes', async ({ page }) => {
    await page.goto('/about')
    await page.getByRole('button', { name: 'Inspect cameras' }).click()
    const report = page.locator('.camera-report')
    await expect(report).toBeVisible()
    await expect(report).toContainText('Active camera:')
    await expect(report).toContainText(/Detected rear lenses: \d+/)
  })

  test('corner buttons: About always, Install once the browser offers it', async ({ page }) => {
    await gotoHome(page)
    await expect(page.getByRole('link', { name: 'About Kody Video' })).toBeVisible()
    // Headless Chromium never fires beforeinstallprompt on its own.
    await expect(page.getByRole('button', { name: 'Install app' })).toHaveCount(0)
    await page.evaluate(() => {
      window.dispatchEvent(new Event('beforeinstallprompt'))
    })
    await expect(page.getByRole('button', { name: 'Install app' })).toBeVisible()
  })

  test('install button opens an explainer popover; Install consumes the prompt', async ({
    page,
  }) => {
    await gotoHome(page)
    await page.evaluate(() => {
      window.dispatchEvent(new Event('beforeinstallprompt'))
    })
    await page.getByRole('button', { name: 'Install app' }).click()
    const explainer = page.getByRole('dialog', { name: 'Install Kody Video' })
    await expect(explainer).toBeVisible()
    await expect(explainer).toContainText('works offline')

    // Escape / outside click dismisses without consuming the prompt.
    await page.keyboard.press('Escape')
    await expect(explainer).toBeHidden()

    // The corner button is a toggle: tap to open, tap again to dismiss.
    await page.getByRole('button', { name: 'Install app' }).click()
    await expect(explainer).toBeVisible()
    await page.getByRole('button', { name: 'Install app' }).click()
    await expect(explainer).toBeHidden()
    await expect(page.getByRole('button', { name: 'Install app' })).toBeVisible()
    await page.getByRole('button', { name: 'Install app' }).click()
    await expect(explainer).toBeVisible()

    // Install consumes the one-shot prompt: popover and corner button go away.
    await explainer.getByRole('button', { name: 'Install' }).click()
    await expect(explainer).toBeHidden()
    await expect(page.getByRole('button', { name: 'Install app' })).toHaveCount(0)
  })

  test('about, privacy, and terms pages render', async ({ page }) => {
    await gotoHome(page)
    await page.getByRole('link', { name: 'About Kody Video' }).click()
    await page.waitForURL(/\/about/)
    await expect(page.locator('body')).toContainText('Kody Video')
    await page.goto('/privacy')
    await expect(page.getByRole('heading', { name: 'Privacy', exact: true })).toBeVisible()
    await page.goto('/terms')
    await expect(page.getByRole('heading', { name: 'Terms', exact: true })).toBeVisible()
  })
})

test.describe('lazy project creation', () => {
  test('backing out before recording leaves no project behind', async ({ page }) => {
    await openNewProject(page)
    expect(page.url()).toContain('/project/new')
    await page.getByRole('link', { name: 'Back to projects' }).click()
    await page.waitForURL(/\/$/)
    const projects = await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      return (await storage.listProjects()).length
    })
    expect(projects).toBe(0)
    await expect(page.locator('.project-slot.filled')).toHaveCount(0)
  })

  test('exiting a project still in its default state auto-deletes it', async ({ page }) => {
    await openNewProject(page)
    // The first take persists the project…
    await recordClip(page)
    await page.waitForURL((url) => !url.pathname.endsWith('/project/new'))
    // …but deleting it leaves the project exactly as a fresh one: no clips,
    // default name. Exiting must remove it silently.
    await page.getByRole('button', { name: 'Delete last clip' }).click()
    await expect(page.locator('.toast')).toContainText('Last clip deleted')
    await page.getByRole('link', { name: 'Back to projects' }).click()
    await page.waitForURL(/\/$/)
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const storage = await import('/src/lib/storage.ts')
          return (await storage.listProjects()).length
        }),
      )
      .toBe(0)
    await expect(page.locator('.project-slot.filled')).toHaveCount(0)
  })
})
