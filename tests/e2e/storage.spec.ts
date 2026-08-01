import { test, expect, type Page } from '@playwright/test'
import { gotoHome, seedProject } from './helpers'

function listExportCache(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('exports', { create: true })
    const names: string[] = []
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
      names.push(name)
    }
    return names.sort()
  })
}

/** A cache entry the boot sweep must respect: a real project referenced by
 * AppMeta.lastExport, with bytes on disk. */
async function seedReferencedExportCache(page: Page, sizeBytes: number): Promise<void> {
  const projectId = await seedProject(page, { clips: 1 })
  await page.evaluate(
    async ({ id, size }) => {
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle('exports', { create: true })
      const handle = await dir.getFileHandle('last-export.mp4', { create: true })
      const writable = await handle.createWritable()
      await writable.write(new Uint8Array(size))
      await writable.close()

      const storage = await import('/src/lib/storage.ts')
      const db = await storage.getDb()
      const settings = await storage.getSettings()
      await db.put('meta', {
        ...settings,
        lastExport: {
          projectId: id,
          opfsName: 'last-export.mp4',
          mimeType: 'video/mp4',
          fileExtension: 'mp4',
          createdAt: Date.now(),
          signature: 'e2e-seeded',
          watermarked: true,
        },
      })
    },
    { id: projectId, size: sizeBytes },
  )
}

test.describe('storage management', () => {
  test('boot sweep removes orphaned cache files but keeps a referenced export', async ({
    page,
  }) => {
    await seedReferencedExportCache(page, 2048)
    // Orphans: a stale temp and a zip nothing references.
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle('exports', { create: true })
      for (const name of ['export-123.mp4', 'clips.zip']) {
        const handle = await dir.getFileHandle(name, { create: true })
        const writable = await handle.createWritable()
        await writable.write(new Uint8Array(1024))
        await writable.close()
      }
    })
    expect(await listExportCache(page)).toEqual(['clips.zip', 'export-123.mp4', 'last-export.mp4'])

    await page.reload()
    await expect(page.locator('.home-hero')).toBeVisible()
    await expect.poll(() => listExportCache(page)).toEqual(['last-export.mp4'])
  })

  test('storage banner offers one-tap cache clearing when space runs hot', async ({
    browser,
  }) => {
    const context = await browser.newContext()
    await context.addInitScript(() => {
      Object.defineProperty(navigator.storage, 'estimate', {
        value: async () => ({ usage: 0.85 * 1e9, quota: 1e9 }),
      })
    })
    const page = await context.newPage()
    await gotoHome(page)
    await seedReferencedExportCache(page, 4096)
    await page.reload()

    const banner = page.locator('.storage-banner')
    await expect(banner).toBeVisible()
    await banner.getByRole('button', { name: /Clear cached exports/ }).click()
    await expect(page.getByText(/Cleared cached export files — freed/)).toBeVisible()
    await expect.poll(() => listExportCache(page)).toEqual([])
    const lastExport = await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      return (await storage.getSettings()).lastExport ?? null
    })
    expect(lastExport).toBeNull()
    await context.close()
  })

  test('about page shows cache size and clears it', async ({ page }) => {
    await seedReferencedExportCache(page, 5 * 1024 * 1024)
    await page.goto('/about')
    const section = page.locator('.about-section', { hasText: 'Cached export files' })
    await expect(section).toContainText('5 MB')
    await section.getByRole('button', { name: 'Clear' }).click()
    await expect(section.getByText(/Freed 5 MB/)).toBeVisible()
    await expect(section).toContainText('Cached export files: 0 MB')
    await expect.poll(() => listExportCache(page)).toEqual([])
  })

  test('deleting a project drops its cached export with it', async ({ page }) => {
    await seedReferencedExportCache(page, 2048)
    await page.reload()
    await page.locator('.slot-options').click()
    await page.getByRole('button', { name: 'Delete' }).click()
    await page.locator('.confirm-sheet').getByRole('button', { name: 'Delete' }).click()
    await expect(page.locator('.project-slot.filled')).toHaveCount(0)

    await expect.poll(() => listExportCache(page)).toEqual([])
    const lastExport = await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      return (await storage.getSettings()).lastExport ?? null
    })
    expect(lastExport).toBeNull()
  })
})
