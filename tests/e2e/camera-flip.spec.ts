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

  test('a head-shake "no" twist flips the camera; a fan motion does not', async ({ page }) => {
    await openNewProject(page)
    const video = page.locator('.camera-video')
    await expect(video).not.toHaveClass(/mirror/)

    // Real-time 60 Hz devicemotion events (the detector reads event.timeStamp):
    // a 3 Hz, 400 deg/s oscillation on one rotationRate axis, then stillness.
    const shake = (axis: 'alpha' | 'beta' | 'gamma') =>
      page.evaluate(
        (axis) =>
          new Promise<void>((resolve) => {
            const started = performance.now()
            const timer = window.setInterval(() => {
              const elapsed = performance.now() - started
              const moving = elapsed < 700
              const value = moving ? 400 * Math.sin(2 * Math.PI * 3 * (elapsed / 1000)) : 0
              const rotationRate = { alpha: 0, beta: 0, gamma: 0, [axis]: value }
              window.dispatchEvent(new DeviceMotionEvent('devicemotion', { rotationRate }))
              if (elapsed > 1000) {
                window.clearInterval(timer)
                resolve()
              }
            }, 16)
          }),
        axis,
      )

    // gamma = rotation around the axis out of the screen: no flip.
    await shake('gamma')
    await page.waitForTimeout(500)
    await expect(video).not.toHaveClass(/mirror/)

    // beta = device y, the vertical axis of an upright phone: flips.
    await shake('beta')
    await expect(page.getByText('Camera flipped')).toBeVisible()
    await expect(video).toHaveClass(/mirror/, { timeout: 5_000 })

    // Past the cooldown, the same shake flips back.
    await page.waitForTimeout(1000)
    await shake('beta')
    await expect(video).not.toHaveClass(/mirror/, { timeout: 5_000 })
  })
})
