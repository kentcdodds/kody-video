import { test, expect, type Page } from '@playwright/test'
import { gotoHome, unlockPlus } from './helpers'

async function mintPlusRestoreCode(page: Page): Promise<string> {
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
      (window as unknown as { __kodyScheduleUpdateErrors?: string[] }).__kodyScheduleUpdateErrors ??
      [],
  )
  expect(scheduleUpdateErrors).toEqual([])
  await expect(sheet.getByText(/kody\.video\/unlocked/)).toBeVisible()
  return code
}

test.describe('Plus restore codes', () => {
  test('the other device can type the code on /unlocked', async ({ page, browser, baseURL }) => {
    const receiverContext = await browser.newContext({ baseURL })
    const receiver = await receiverContext.newPage()
    try {
      const code = await mintPlusRestoreCode(page)
      await expect(page.locator('img.sync-qr')).toBeVisible()
      const qrSrc = await page.locator('img.sync-qr').getAttribute('src')
      expect(qrSrc ?? '').toMatch(/^data:image\/svg\+xml/)

      await receiver.goto('/unlocked')
      await expect(receiver.getByRole('heading', { name: 'Unlock Plus' })).toBeVisible()
      await expect(receiver.getByRole('link', { name: 'Back to projects' })).toBeVisible()
      await receiver.getByLabel('Plus code').fill(code)
      await receiver.getByRole('button', { name: 'Unlock' }).click()
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

  test('an invalid /unlocked path still offers the code form', async ({ page }) => {
    await page.goto('/unlocked/nope')
    await expect(page.getByRole('heading', { name: 'Unlock Plus' })).toBeVisible()
    await expect(page.getByText(/Enter the short code from the other device/)).toBeVisible()
    await expect(page.getByLabel('Plus code')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Unlock' })).toBeVisible()
  })

  test('a QR / path code still redeems on /unlocked/:code', async ({ page, browser, baseURL }) => {
    const receiverContext = await browser.newContext({ baseURL })
    const receiver = await receiverContext.newPage()
    try {
      const code = await mintPlusRestoreCode(page)
      await receiver.goto(`/unlocked/${code}`)
      await expect(receiver.getByRole('heading', { name: /Plus unlocked/ })).toBeVisible({
        timeout: 15_000,
      })
    } finally {
      await receiverContext.close()
    }
  })
})
