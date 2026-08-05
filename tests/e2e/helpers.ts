import { expect, type Page } from '@playwright/test'

/** Visit home with onboarding already dismissed — nearly every spec wants
 * this, and the overlay lives on the project page, so setting the flag from
 * home always lands before it can appear. */
export async function gotoHome(page: Page): Promise<void> {
  await page.goto('/')
  await page.evaluate(async () => {
    const storage = await import('/src/lib/storage.ts')
    await storage.setOnboardingDismissed(true)
  })
}

/** Home → empty "New project" slot → camera preview streaming. */
export async function openNewProject(page: Page): Promise<void> {
  await gotoHome(page)
  await page.locator('.project-slot.empty').first().click()
  await page.waitForURL(/\/project\//)
  await waitForCameraReady(page)
}

export async function waitForCameraReady(page: Page): Promise<void> {
  const video = page.locator('.camera-video')
  await video.waitFor()
  await expect
    .poll(
      () =>
        video.evaluate((el) => (el as HTMLVideoElement).readyState >= 2 && !(el as HTMLVideoElement).paused),
      { timeout: 15_000 },
    )
    .toBe(true)
}

export async function totalClipCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const storage = await import('/src/lib/storage.ts')
    const projects = await storage.listProjects()
    let total = 0
    for (const project of projects) {
      total += (await storage.getClipMetasForProject(project.id)).length
    }
    return total
  })
}

/** Press the record stage until the REC pill confirms recording started.
 * Presses during a previous take's async cleanup are ignored by the app's
 * reentrancy guard (correct behavior) — a real user just presses again. */
export async function pressStageUntilRecording(page: Page): Promise<void> {
  const box = await page.locator('.record-stage').boundingBox()
  if (!box) throw new Error('record stage not visible')
  let started = false
  for (let attempt = 0; attempt < 4 && !started; attempt += 1) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    started = await page
      .locator('.record-pill')
      .waitFor({ timeout: 2_500 })
      .then(
        () => true,
        () => false,
      )
    if (!started) {
      await page.mouse.up()
      await page.waitForTimeout(400)
    }
  }
  expect(started, 'record pill should appear after pressing the stage').toBe(true)
}

/**
 * Hold-to-record one clip via a mouse hold on the preview, then wait until
 * it lands in IndexedDB. Two app behaviors demand retries here, both
 * correct: presses during the previous take's async cleanup are ignored by
 * the reentrancy guard, and takes whose captured media measures under the
 * 120ms minimum (MediaRecorder starving for frames under CI load) are
 * dropped like a too-short tap. A real user presses again; so does this.
 */
export async function recordClip(page: Page, holdMs = 1200): Promise<void> {
  const before = await totalClipCount(page)
  for (let take = 0; take < 3; take += 1) {
    await pressStageUntilRecording(page)
    await page.waitForTimeout(holdMs)
    await page.mouse.up()
    const saved = await expect
      .poll(() => totalClipCount(page), { timeout: 15_000 })
      .toBe(before + 1)
      .then(
        () => true,
        () => false,
      )
    if (saved) return
  }
  throw new Error(`recordClip: clip count stuck at ${before} after 3 takes`)
}

/**
 * Seed a project with deterministic fixture clips (encoded in-page, faster
 * than realtime) and open its camera view. Specs that assert on editing,
 * playback, export, or project management use this; actual hold-to-record
 * capture is covered by the recording specs.
 */
export async function seedProject(
  page: Page,
  options: { clips: number; clipMs?: number; name?: string } = { clips: 1 },
): Promise<string> {
  await gotoHome(page)
  const projectId = await page.evaluate(
    async ({ clips, clipMs, name }) => {
      const storage = await import('/src/lib/storage.ts')
      const thumbs = await import('/src/lib/thumbs.ts')
      const { makeTestClipBlob } = await import('/src/lib/testing/make-test-clip.ts')
      const project = await storage.createProject(name)
      const blob = await makeTestClipBlob(clipMs)
      for (let i = 0; i < clips; i += 1) {
        const clip = await storage.addClip({
          projectId: project.id,
          blob,
          mimeType: 'video/webm',
          durationMs: clipMs,
          width: 320,
          height: 568,
        })
        // Thumbs/posters are generated at record time in the real flow.
        await thumbs.ensureClipThumbs(clip)
      }
      return project.id
    },
    { clips: options.clips, clipMs: options.clipMs ?? 1500, name: options.name },
  )
  return projectId
}

export async function openSeededProject(
  page: Page,
  options: { clips: number; clipMs?: number; name?: string } = { clips: 1 },
): Promise<string> {
  const projectId = await seedProject(page, options)
  await page.goto(`/project/${projectId}`)
  await waitForCameraReady(page)
  return projectId
}

/** Unlock Kody Video Plus (6 projects, no watermark) straight in storage. */
export async function unlockPlus(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const entitlement = await import('/src/lib/entitlement.ts')
    await entitlement.markWatermarkRemoved('cs_test_e2e')
  })
}

export const IOS_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'
