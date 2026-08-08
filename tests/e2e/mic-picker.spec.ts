import { test, expect } from '@playwright/test'
import { openNewProject, recordClip } from './helpers'

/**
 * Audio input chooser: with more than one microphone a mic button appears in
 * the record chrome, opens a picker sheet, and the choice is requested (by
 * exact device id) when the take's mic is opened — with a graceful fallback
 * to the default mic when the exact request cannot be satisfied (the fake
 * media stack has no such device, which conveniently exercises exactly that
 * path).
 */

declare global {
  interface Window {
    __audioRequests: unknown[]
  }
}

/** Adds a second (fake) audio input and records every audio constraint
 * passed to getUserMedia. */
async function installSecondMic(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    const media = navigator.mediaDevices
    const originalEnumerate = media.enumerateDevices.bind(media)
    media.enumerateDevices = async () => {
      const devices = await originalEnumerate()
      const extra = {
        deviceId: 'usb-desk-mic',
        groupId: 'usb-desk-mic-group',
        kind: 'audioinput',
        label: 'USB Desk Microphone',
        toJSON() {
          return this
        },
      } as MediaDeviceInfo
      return [...devices, extra]
    }
    window.__audioRequests = []
    const originalGum = media.getUserMedia.bind(media)
    media.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      if (constraints?.audio) {
        window.__audioRequests.push(JSON.parse(JSON.stringify(constraints.audio)))
      }
      return originalGum(constraints)
    }
  })
}

test.describe('audio input chooser', () => {
  test('hidden when only one microphone exists', async ({ page }) => {
    await page.addInitScript(() => {
      const media = navigator.mediaDevices
      const originalEnumerate = media.enumerateDevices.bind(media)
      media.enumerateDevices = async () => {
        const devices = await originalEnumerate()
        const firstMic = devices.find((device) => device.kind === 'audioinput')
        return [
          ...devices.filter((device) => device.kind !== 'audioinput'),
          ...(firstMic ? [firstMic] : []),
        ]
      }
    })
    await openNewProject(page)
    // The list syncs after mic priming; poll instead of asserting instantly.
    await page.waitForTimeout(1000)
    await expect(page.getByRole('button', { name: 'Choose microphone' })).toHaveCount(0)
  })

  test('picks a mic, requests it for the take, and remembers the choice', async ({ page }) => {
    await installSecondMic(page)
    await openNewProject(page)

    const micButton = page.getByRole('button', { name: 'Choose microphone' })
    await micButton.click()

    const sheet = page.getByRole('dialog', { name: 'Choose a microphone' })
    await expect(sheet).toBeVisible()
    await sheet.getByRole('button', { name: 'USB Desk Microphone' }).click()
    await expect(sheet).toHaveCount(0)

    // The choice persists for future sessions.
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('kodyVideo.audioInput')))
      .toContain('usb-desk-mic')

    // A take asks for the chosen mic by exact id...
    await recordClip(page)
    const requests = await page.evaluate(() => window.__audioRequests)
    expect(
      requests.some((audio) => JSON.stringify(audio).includes('"exact":"usb-desk-mic"')),
    ).toBe(true)
    // ...and the clip still saved (recordClip asserted it): the nonexistent
    // fake device fell back to the default mic instead of failing the take.

    // Reopening the picker highlights the remembered mic.
    await micButton.click()
    await expect(
      page.getByRole('button', { name: /USB Desk Microphone/ }),
    ).toHaveAttribute('aria-pressed', 'true')
  })
})
