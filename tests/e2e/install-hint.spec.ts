import { test, expect } from '@playwright/test'
import { IOS_SAFARI_UA } from './helpers'

test.describe('iOS install hint', () => {
  test('shows in iOS Safari and dismisses for good', async ({ browser }) => {
    const context = await browser.newContext({ userAgent: IOS_SAFARI_UA })
    const page = await context.newPage()
    await page.goto('/')
    const hint = page.locator('.home-install-hint')
    await expect(hint).toBeVisible()
    await expect(hint).toContainText('Add to Home Screen')
    await page.getByRole('button', { name: 'Dismiss install tip' }).click()
    await expect(hint).toBeHidden()
    await page.reload()
    await expect(page.locator('.home-install-hint')).toBeHidden()
    await context.close()
  })

  test('hidden in installed (standalone) mode', async ({ browser }) => {
    const context = await browser.newContext({ userAgent: IOS_SAFARI_UA })
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { get: () => true })
    })
    const page = await context.newPage()
    await page.goto('/')
    await expect(page.locator('.home-hero')).toBeVisible()
    await expect(page.locator('.home-install-hint')).toBeHidden()
    await context.close()
  })

  test('hidden in non-iOS browsers', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.home-hero')).toBeVisible()
    await expect(page.locator('.home-install-hint')).toBeHidden()
  })
})
