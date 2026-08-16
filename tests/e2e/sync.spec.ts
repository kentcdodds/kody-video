import { test, expect } from '@playwright/test'
import { seedProject, unlockPlus } from './helpers'

test.describe('send to device', () => {
  test('free plan opens Plus upsell from Send to device', async ({ page }) => {
    await seedProject(page, { clips: 1, name: 'Family' })
    await page.goto('/')
    await page.locator('.slot-options').click()
    await page.getByRole('button', { name: 'Send to device' }).click()
    const upsell = page.getByRole('dialog', { name: 'Kody Video Plus' })
    await expect(upsell).toBeVisible()
    await expect(upsell).toContainText(/sending a project to another device/i)
  })

  test('Plus send copies a project to another browser over WebRTC', async ({ browser }) => {
    const senderContext = await browser.newContext()
    const receiverContext = await browser.newContext()
    const sender = await senderContext.newPage()
    const receiver = await receiverContext.newPage()
    try {
      await seedProject(sender, { clips: 1, name: 'Lan trip' })
      await unlockPlus(sender)
      await sender.goto('/')
      await expect(sender.locator('.project-slot.filled')).toContainText('Lan trip')
      await sender.locator('.slot-options').click()
      await sender.getByRole('button', { name: 'Send to device' }).click()
      const sheet = sender.getByRole('dialog', { name: /Send Lan trip/ })
      await expect(sheet).toBeVisible()
      const code = await sheet.locator('.sync-code').innerText()
      expect(code.replace(/[^A-Z0-9]/g, '')).toHaveLength(6)

      await receiver.goto(`/receive/${code.replace(/[^A-Z0-9]/g, '')}`)
      await receiver.waitForURL(/\/project\//, { timeout: 45_000 })
      const received = await receiver.evaluate(async () => {
        const storage = await import('/src/lib/storage.ts')
        const projects = await storage.listProjects()
        if (projects.length !== 1) return null
        const clips = await storage.getClipMetasForProject(projects[0]!.id)
        return { name: projects[0]!.name, clips: clips.length }
      })
      expect(received).toEqual({ name: 'Lan trip', clips: 1 })
      await expect(sheet).toContainText(/Sent/)
    } finally {
      await senderContext.close()
      await receiverContext.close()
    }
  })
})
