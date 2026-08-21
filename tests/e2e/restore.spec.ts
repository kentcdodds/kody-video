import { test, expect } from '@playwright/test'
import { gotoHome, unlockPlus } from './helpers'

test.describe('Plus restore codes', () => {
  test('the Plus device shows a code the other browser can redeem', async ({
    page,
    browser,
    baseURL,
  }) => {
    const receiverContext = await browser.newContext({ baseURL })
    const receiver = await receiverContext.newPage()
    try {
      // Catch the SharePlusSheet setup regression (KODY Sentry 7685051724):
      // sync handle.update() before Remix wires scheduleUpdate.
      await page.addInitScript(() => {
        window.addEventListener('unhandledrejection', (event) => {
          const msg =
            event.reason instanceof Error ? event.reason.message : String(event.reason ?? '')
          if (!msg.includes('scheduleUpdate')) return
          const w = window as unknown as { __kodyScheduleUpdateErrors?: string[] }
          ;(w.__kodyScheduleUpdateErrors ??= []).push(msg)
        })
      })
      await gotoHome(page)
      await unlockPlus(page)
      await page.goto('/about')
      await page.getByRole('button', { name: 'Use Plus on another device' }).click()
      const sheet = page.getByRole('dialog', { name: 'Use Plus on another device' })
      await expect(sheet).toBeVisible()
      const code = (await sheet.locator('.sync-code').innerText()).replace(/[^A-Z0-9]/g, '')
      expect(code).toHaveLength(6)
      const scheduleUpdateErrors = await page.evaluate(
        () =>
          (window as unknown as { __kodyScheduleUpdateErrors?: string[] })
            .__kodyScheduleUpdateErrors ?? [],
      )
      expect(scheduleUpdateErrors).toEqual([])

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
