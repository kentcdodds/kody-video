import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import {
  openNewProject,
  pressStageUntilRecording,
  recordClip,
  saveScreenshot,
  totalClipCount,
} from './helpers'

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

  test('a take that records no video is not saved and says so', async ({ page }, testInfo) => {
    // The camera stops feeding the encoder while the mic keeps going: the
    // take's file carries audio only (the broken-clip shape seen in the wild).
    await page.addInitScript(() => {
      const Native = window.MediaRecorder
      window.MediaRecorder = class extends Native {
        constructor(stream: MediaStream, options?: MediaRecorderOptions) {
          const audio = stream.getAudioTracks()
          super(audio.length > 0 ? new MediaStream(audio) : stream, options)
        }
      }
    })
    await openNewProject(page)

    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await pressStageUntilRecording(page)
      await page.waitForTimeout(1200)
      await page.mouse.up()
      await expect(page.locator('.toast')).toHaveText("That clip didn't record any video. Try again.", {
        timeout: 15_000,
      })
      await saveScreenshot(page, testInfo, `record-no-video-${colorScheme}`)
      expect(await totalClipCount(page)).toBe(0)
      await expect(page.locator('.toast')).toHaveCount(0, { timeout: 10_000 })
    }

    const outcomes = await page.evaluate(async () => {
      const diagnostics = await import('/src/lib/capture-diagnostics.ts')
      const reports = await diagnostics.listTakeReports()
      return reports.map((report: { outcome: string; clipId?: string }) => ({
        outcome: report.outcome,
        clipId: report.clipId ?? null,
      }))
    })
    expect(outcomes).toEqual([
      { outcome: 'no-video', clipId: null },
      { outcome: 'no-video', clipId: null },
    ])

    await page.goto('/about#recording-health')
    await expect(page.locator('#recording-health .recording-health-takes li').first()).toContainText(
      'recorded no video',
    )
  })
})
