import { test, expect } from '@playwright/test'
import { openNewProject } from './helpers'

// Two fake cameras so the flip button is enabled at all.
test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream=device-count=2',
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
})

test.describe('camera flip', () => {
  test('mirror applies only when the selfie feed actually arrives', async ({ page }) => {
    // Slow down the selfie-camera open so the warm-up window is observable:
    // the bug was the still-showing REAR feed mirroring the moment flip was
    // tapped, a full camera warm-up before the selfie feed replaced it.
    await page.addInitScript(() => {
      const media = navigator.mediaDevices
      const original = media.getUserMedia.bind(media)
      media.getUserMedia = async (constraints?: MediaStreamConstraints) => {
        const wantsSelfie = JSON.stringify(constraints?.video ?? {}).includes('user')
        if (wantsSelfie) {
          await new Promise((resolve) => {
            setTimeout(resolve, 900)
          })
        }
        return original(constraints)
      }
    })

    await openNewProject(page)
    const video = page.locator('.camera-video')
    await expect(video).not.toHaveClass(/mirror/)

    await page.getByRole('button', { name: 'Flip camera' }).click()
    // Mid warm-up: old feed still showing — it must NOT be mirrored.
    await page.waitForTimeout(300)
    await expect(video).not.toHaveClass(/mirror/)

    // Once the selfie stream lands, the mirror lands with it.
    await expect(video).toHaveClass(/mirror/, { timeout: 5_000 })

    // And flipping back eventually unmirrors.
    await page.getByRole('button', { name: 'Flip camera' }).click()
    await expect(video).not.toHaveClass(/mirror/, { timeout: 5_000 })
  })
})
