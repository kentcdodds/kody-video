import { test, expect, type Page } from '@playwright/test'
import { gotoHome, seedProject, unlockPlus } from './helpers'

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
    // `.home-hero` is a hidden layout spacer on mobile viewports; wait for
    // the project slots to confirm home (and its boot sweep) ran.
    await expect(page.locator('.project-slot').first()).toBeVisible()
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

  test('home storage popover keeps a quality pick after home revalidates', async ({
    page,
  }) => {
    await gotoHome(page)
    await page.locator('.storage-meter').click()
    const popover = page.locator('.storage-popover')
    await expect(popover).toBeVisible()
    await popover.getByRole('radio', { name: 'Saver' }).click()
    await expect(popover.getByRole('radio', { name: 'Saver' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const storage = await import('/src/lib/storage.ts')
          return (await storage.getSettings()).videoQuality ?? null
        }),
      )
      .toBe('saver')
    // The mount/revalidation load must not snap the control back after persist.
    await expect(popover.getByRole('radio', { name: 'Saver' })).toHaveAttribute(
      'aria-checked',
      'true',
    )

    await page.getByRole('link', { name: 'More on About' }).click()
    await expect(page.getByRole('link', { name: 'Back to projects' })).toBeInViewport()
    await expect(page.locator('#video-quality').getByRole('radio', { name: 'Saver' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await page.getByRole('link', { name: 'Back to projects' }).click()
    await expect(page.locator('.project-slots')).toBeVisible()
    await page.locator('.storage-meter').click()
    await expect(page.locator('.storage-popover').getByRole('radio', { name: 'Saver' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  test('about page defaults free quality to Standard and persists Saver', async ({ page }) => {
    await page.goto('/about')
    const section = page.locator('#video-quality')
    await expect(section.getByRole('radio', { name: 'Standard' })).toBeEnabled()
    await expect(section.getByRole('radio', { name: 'Standard' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await section.getByRole('radio', { name: 'High (Kody Video Plus)' }).click()
    await expect(page.getByRole('dialog', { name: 'Kody Video Plus' })).toBeVisible()
    await page.getByRole('button', { name: 'Not now' }).click()

    await section.getByRole('radio', { name: 'Saver' }).click()
    await expect(section.getByRole('radio', { name: 'Saver' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const storage = await import('/src/lib/storage.ts')
          return (await storage.getSettings()).videoQuality ?? null
        }),
      )
      .toBe('saver')

    await page.reload()
    await expect(page.locator('#video-quality').getByRole('radio', { name: 'Saver' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  test('Plus can pick High video quality', async ({ page }) => {
    await gotoHome(page)
    await unlockPlus(page)
    await page.goto('/about')
    const section = page.locator('#video-quality')
    await expect(section.getByRole('radio', { name: 'High' })).toBeEnabled()
    await expect(section.getByRole('radio', { name: 'High' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await expect(section.getByRole('radio', { name: 'High (Kody Video Plus)' })).toHaveCount(0)
    await section.getByRole('radio', { name: 'Standard' }).click()
    await expect(section.getByRole('radio', { name: 'Standard' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await section.getByRole('radio', { name: 'High' }).click()
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const storage = await import('/src/lib/storage.ts')
          return (await storage.getSettings()).videoQuality ?? null
        }),
      )
      .toBe('high')
  })

  test('about page shows cache size and clears it', async ({ page }) => {
    await seedReferencedExportCache(page, 5 * 1024 * 1024)
    await page.goto('/about')
    const backups = page.locator('.about-section', { hasText: 'Import a backup' })
    await expect(backups.locator('.about-import-space')).toContainText(/available/)
    const section = page.locator('#storage')
    const cacheRow = section.locator('.storage-breakdown li', { hasText: 'Cached export files' })
    await expect(cacheRow.locator('strong')).toHaveText('5 MB')
    await cacheRow.getByRole('button', { name: 'Clear' }).click()
    await expect(section.getByText(/Freed 5 MB/)).toBeVisible()
    await expect(cacheRow.locator('strong')).toHaveText('0 MB')
    await expect.poll(() => listExportCache(page)).toEqual([])
  })

  test('home cards and About show how much space each project takes', async ({ page }) => {
    await seedProject(page, { clips: 2, name: 'Trip' })
    const size = await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      const { formatBytes } = await import('/src/lib/storage-space.ts')
      const [project] = await storage.listProjects()
      const bytes = (await storage.measureStorage()).projectBytes.get(project!.id) ?? 0
      return { bytes, label: formatBytes(bytes) }
    })
    expect(size.bytes).toBeGreaterThan(0)

    await page.reload()
    await expect(page.locator('.project-slot.filled .slot-size')).toHaveText(size.label)

    await page.goto('/about')
    const row = page.locator('#storage .storage-breakdown li', { hasText: 'Trip' })
    await expect(row.locator('strong')).toHaveText(size.label)
  })

  test('About cleans up leftovers no project can reach', async ({ page }) => {
    const projectId = await seedProject(page, { clips: 1, name: 'Keeper' })
    await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      const db = await storage.getDb()
      await db.put('media', {
        clipId: 'clip_orphan',
        blob: new Blob([new Uint8Array(3 * 1024 * 1024)], { type: 'video/webm' }),
      })
    })
    await page.goto('/about')
    const section = page.locator('#storage')
    const row = section.locator('.storage-breakdown li', { hasText: 'Leftovers no project uses' })
    await expect(row.locator('strong')).toHaveText('3 MB')
    await row.getByRole('button', { name: 'Clean up' }).click()
    await expect(section.getByText(/Cleaned up leftovers — freed 3 MB/)).toBeVisible()
    await expect(row).toHaveCount(0)
    const clips = await page.evaluate(async (id) => {
      const storage = await import('/src/lib/storage.ts')
      return (await storage.getClipsForProject(id)).length
    }, projectId)
    expect(clips).toBe(1)
  })

  test('clip edits do not grow on-disk usage by another copy of the video', async ({
    playwright,
  }, testInfo) => {
    // A real on-disk profile: incognito contexts keep IndexedDB in memory,
    // where superseded blob copies never show up in the quota estimate.
    const baseURL = testInfo.project.use.baseURL!
    const userDataDir = testInfo.outputPath('profile')
    const context = await playwright.chromium.launchPersistentContext(userDataDir)
    try {
      const page = context.pages()[0] ?? (await context.newPage())
      await page.goto(baseURL)
      const growth = await page.evaluate(async () => {
        const storage = await import('/src/lib/storage.ts')
        const usage = async () => (await navigator.storage.estimate()).usage ?? 0
        const project = await storage.createProject('Quota')
        const clip = await storage.addClip({
          projectId: project.id,
          blob: new Blob([new Uint8Array(8 * 1024 * 1024).fill(3)], { type: 'video/webm' }),
          mimeType: 'video/webm',
          durationMs: 2000,
        })
        const afterAdd = await usage()
        await storage.updateClipAudioPeak(clip.id, 0.5)
        await storage.updateClipTrim(clip.id, 100, 1900)
        await storage.updateClipVolumes(clip.id, { clipVolume: 0.5 })
        await storage.updateClipFit(clip.id, 'letterbox')
        return (await usage()) - afterAdd
      })
      // Each of those four writes used to add a full 8MB copy.
      expect(growth).toBeLessThan(1024 * 1024)
    } finally {
      await context.close()
    }
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
