import { test, expect } from '@playwright/test'
import { gotoHome, openNewProject, unlockPlus } from './helpers'

test.describe('home & app shell', () => {
  test('onboarding shows on first camera open, dismisses for good', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'New project', exact: true }).click()
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

  test('footer shows privacy line with storage usage', async ({ page }) => {
    await gotoHome(page)
    const footer = page.locator('.home-privacy')
    await expect(footer).toContainText('Clips stay on this phone until you share.')
    await expect(footer).toContainText(/of .+ used/)
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
})
