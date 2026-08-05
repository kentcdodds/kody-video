import { test, expect, type Page } from '@playwright/test'
import { gotoHome, seedProject, unlockPlus } from './helpers'

async function createProjectWithClip(page: Page): Promise<void> {
  await seedProject(page, { clips: 1 })
  await page.reload()
  await expect(page.locator('.project-slot.filled')).toHaveCount(1)
}

test.describe('project slots', () => {
  test('recorded project appears with poster art and stable options menu', async ({ page }) => {
    await createProjectWithClip(page)
    const slot = page.locator('.project-slot.filled')
    await expect(slot).toHaveCount(1)
    // Poster art from the first clip arrives asynchronously.
    await expect(page.locator('.project-slot.filled.has-poster')).toHaveCount(1, {
      timeout: 15_000,
    })
  })

  test('rename via options sheet updates the slot', async ({ page }) => {
    await createProjectWithClip(page)
    await page.locator('.slot-options').click()
    await page.getByRole('button', { name: 'Rename' }).click()
    const input = page.locator('#project-name')
    await input.fill('Trip to Moab')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.locator('.project-slot.filled')).toContainText('Trip to Moab')
  })

  test('delete uses a styled confirm and frees stored clips', async ({ page }) => {
    await createProjectWithClip(page)
    let dialogAppeared = false
    page.on('dialog', () => {
      dialogAppeared = true
    })
    await page.locator('.slot-options').click()
    await page.getByRole('button', { name: 'Delete' }).click()
    const confirm = page.locator('.confirm-sheet')
    await expect(confirm).toBeVisible()
    await expect(confirm).toContainText('Delete project?')
    await confirm.getByRole('button', { name: 'Delete' }).click()
    await expect(page.locator('.project-slot.filled')).toHaveCount(0)
    expect(dialogAppeared).toBe(false)

    const clipsLeft = await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      const db = await storage.getDb()
      return db.count('clips')
    })
    expect(clipsLeft).toBe(0)
  })

  test('backup downloads a .kodyvideo file and import restores it', async ({ page }) => {
    await createProjectWithClip(page)
    await page.locator('.slot-options').click()
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Save backup' }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/\.kodyvideo$/)
    const backupPath = await download.path()

    // Delete the original, then round-trip through Import.
    await page.locator('.slot-options').click()
    await page.getByRole('button', { name: 'Delete' }).click()
    await page.locator('.confirm-sheet').getByRole('button', { name: 'Delete' }).click()
    await expect(page.locator('.project-slot.filled')).toHaveCount(0)

    // Import lives on the About page now.
    await page.goto('/about')
    await page.locator('.about-import input[type="file"]').setInputFiles(backupPath)
    // Import navigates straight into the restored project.
    await page.waitForURL(/\/project\//, { timeout: 30_000 })
    const restored = await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      const projects = await storage.listProjects()
      if (projects.length !== 1) return null
      const clips = await storage.getClipMetasForProject(projects[0]!.id)
      return { clips: clips.length }
    })
    expect(restored).toEqual({ clips: 1 })
  })

  test('import is blocked at the plan limit with a clear message', async ({ page }) => {
    await createProjectWithClip(page)
    await page.locator('.slot-options').click()
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Save backup' }).click()
    const backupPath = await (await downloadPromise).path()

    // Still at the free 1-project cap — importing a second must be refused.
    await page.goto('/about')
    await page.locator('.about-import input[type="file"]').setInputFiles(backupPath)
    await expect(page.locator('.error-banner')).toContainText(/free plan|limit/i)
    const projects = await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      return (await storage.listProjects()).length
    })
    expect(projects).toBe(1)
  })

  test('slot order is stable after opening a project', async ({ page }) => {
    await gotoHome(page)
    await unlockPlus(page)
    await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      await storage.createProject('First')
      await new Promise((resolve) => setTimeout(resolve, 5))
      await storage.createProject('Second')
    })
    await page.reload()
    const names = () => page.locator('.project-slot.filled').allTextContents()
    const before = await names()
    // Open the second project, come back, order must not shuffle.
    await page.locator('.project-slot.filled .slot-open').nth(1).click()
    await page.waitForURL(/\/project\//)
    await page.getByRole('link', { name: 'Back to projects' }).click()
    await page.waitForURL(/\/$/)
    expect(await names()).toEqual(before)
  })
})
