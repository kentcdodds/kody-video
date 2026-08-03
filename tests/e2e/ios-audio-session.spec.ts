import { test, expect } from '@playwright/test'
import { IOS_SAFARI_UA, openNewProject } from './helpers'

test.use({ userAgent: IOS_SAFARI_UA })

/**
 * iOS routes capture to external Bluetooth mics (DJI etc.) only after the
 * post-getUserMedia audio-session kick — see src/lib/audio-session.ts.
 * WebKit can't run here, so the navigator.audioSession surface is stubbed
 * and the assertion is on the exact transition sequence.
 */
test.describe('iOS audio session routing', () => {
  test('capture engages play-and-record; stopping restores playback/auto', async ({ page }) => {
    await page.addInitScript(() => {
      const log: string[] = []
      const session = {}
      Object.defineProperty(session, 'type', {
        get: () => log[log.length - 1] ?? 'auto',
        set: (value: string) => {
          log.push(value)
        },
      })
      Object.defineProperty(navigator, 'audioSession', { value: session })
      ;(window as unknown as { __audioSessionLog: string[] }).__audioSessionLog = log
    })

    // On iOS the mic is acquired WITH the camera, so opening the camera view
    // is what starts capture.
    await openNewProject(page)
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __audioSessionLog: string[] }).__audioSessionLog,
        ),
      )
      .toContain('play-and-record')

    // Leaving the camera stops the stream — the sticky session must be
    // reset ('playback' then 'auto') or playback quality stays degraded.
    await page.getByRole('link', { name: 'Back to projects' }).click()
    await page.waitForURL(/\/$/)
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { __audioSessionLog: string[] }).__audioSessionLog.slice(-2),
        ),
      )
      .toEqual(['playback', 'auto'])
  })
})
