import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { openNewProject, recordClip } from './helpers'

test.describe('recording health reports', () => {
  test('a take is analyzed on-device and exportable from About', async ({ page }) => {
    const nonGetRequests: string[] = []
    page.on('request', (request) => {
      if (request.method() !== 'GET') nonGetRequests.push(`${request.method()} ${request.url()}`)
    })

    await openNewProject(page)
    await recordClip(page, 1500)

    // The report is saved at once, then filled in from the saved file's
    // frame timings once capture is idle.
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const diagnostics = await import('/src/lib/capture-diagnostics.ts')
            const [report] = await diagnostics.listTakeReports()
            if (!report?.cadence) return null
            return {
              outcome: report.outcome,
              hasClip: typeof report.clipId === 'string',
              framesInKeptRange: report.cadence.frames > 0,
              expected: report.cadence.expectedFrames > 0,
              verdictKnown: report.verdict !== 'unknown',
              encoderFacts: typeof report.encoder?.flushMs === 'number',
              liveSignals: typeof report.live.mainThread.maxLagMs === 'number',
            }
          }),
        { timeout: 20_000 },
      )
      .toEqual({
        outcome: 'saved',
        hasClip: true,
        framesInKeptRange: true,
        expected: true,
        verdictKnown: true,
        encoderFacts: true,
        liveSignals: true,
      })

    await page.goto('/about#recording-health')
    const section = page.locator('#recording-health')
    await expect(section.getByRole('heading', { name: 'Recording health' })).toBeVisible()
    await expect(section.locator('.recording-health-summary')).toContainText(/^1 take since/)
    await expect(section.locator('.recording-health-takes li')).toHaveCount(1)
    await expect(section.locator('.recording-health-takes li')).toContainText(/fps/)
    // Off the reporting hosts there is no Send button at all.
    await expect(section.getByRole('button', { name: 'Send to Kody Video' })).toHaveCount(0)

    // Headless Chromium has no Web Share, so Share falls back to a download.
    const downloadPromise = page.waitForEvent('download')
    await section.getByRole('button', { name: 'Share report' }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe('kody-video-recording-report.txt')
    const exported = JSON.parse(await readFile((await download.path())!, 'utf8'))
    expect(exported.kind).toBe('kody-video-recording-report')
    expect(exported.summary.takes).toBe(1)
    expect(exported.takes[0].cadence.frames).toBeGreaterThan(0)
    // Timings and counters only.
    expect(JSON.stringify(exported)).not.toMatch(/"(lat|lng|name|blob)"/)

    // Clear asks for a second tap.
    await section.getByRole('button', { name: 'Clear' }).click()
    await section.getByRole('button', { name: 'Tap again to clear' }).click()
    await expect(section).toContainText('No takes recorded on this device yet.')

    expect(nonGetRequests).toEqual([])
  })
})
