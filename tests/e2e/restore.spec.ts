import { test, expect } from '@playwright/test'
import { unlockPlus } from './helpers'

test.describe('Plus restore codes', () => {
  test('the Plus device shows a code the other browser can redeem', async ({
    page,
    browser,
    baseURL,
  }) => {
    const receiverContext = await browser.newContext({ baseURL })
    const receiver = await receiverContext.newPage()
    try {
      await unlockPlus(page)
      await page.goto('/about')
      await page.getByRole('button', { name: 'Use Plus on another device' }).click()
      const sheet = page.getByRole('dialog', { name: 'Use Plus on another device' })
      await expect(sheet).toBeVisible()
      const code = (await sheet.locator('.sync-code').innerText()).replace(/[^A-Z0-9]/g, '')
      expect(code).toHaveLength(6)

      await receiver.goto(`/unlocked?code=${code}`)
      await expect(receiver.getByRole('heading', { name: /Plus unlocked/ })).toBeVisible({
        timeout: 15_000,
      })
      const unlocked = await receiver.evaluate(async () => {
        const storage = await import('/src/lib/storage.ts')
        const settings = await storage.getSettings()
        return settings.watermarkRemoved === true
      })
      expect(unlocked).toBe(true)
    } finally {
      await receiverContext.close()
    }
  })
})
