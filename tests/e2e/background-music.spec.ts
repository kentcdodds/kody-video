import { test, expect, type Page } from '@playwright/test'
import {
  openSeededProject,
  seedProject,
  unlockPlus,
  waitForCameraReady,
} from './helpers'

/** Tiny mono 16-bit PCM WAV — decodable everywhere, generated in-test. */
function makeWavFile(durationSec = 4, freq = 440) {
  const rate = 8000
  const samples = Math.round(durationSec * rate)
  const dataSize = samples * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(rate, 24)
  buffer.writeUInt32LE(rate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000), 44 + i * 2)
  }
  return { name: 'test-song.wav', mimeType: 'audio/wav', buffer }
}

async function openEditor(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open editor' }).click()
  await expect(page.locator('.editor-screen')).toBeVisible()
}

async function openPlusEditorWithClips(page: Page, clips: number): Promise<string> {
  const projectId = await seedProject(page, { clips, clipMs: 3000 })
  await unlockPlus(page)
  await page.goto(`/project/${projectId}`)
  await waitForCameraReady(page)
  await openEditor(page)
  return projectId
}

async function addMusic(page: Page): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Add background music' }).click()
  const chooser = await chooserPromise
  await chooser.setFiles(makeWavFile())
  await expect(page.locator('.audio-track-name')).toHaveText('test-song.wav', {
    timeout: 15_000,
  })
}

/** Range inputs need value + input/change events, not fill(). */
async function setSlider(page: Page, ariaLabel: string | RegExp, value: number): Promise<void> {
  await page.getByRole('slider', { name: ariaLabel }).evaluate((el, v) => {
    const input = el as HTMLInputElement
    input.value = String(v)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
}

async function storedAudio(page: Page) {
  return page.evaluate(async () => {
    const storage = await import('/src/lib/storage.ts')
    const projects = await storage.listProjects()
    const audio = await storage.getProjectAudio(projects[0]!.id)
    return audio
      ? {
          name: audio.name,
          durationMs: audio.durationMs,
          defaultVolume: audio.defaultVolume,
          size: audio.blob.size,
        }
      : null
  })
}

async function storedClipVolumes(page: Page): Promise<Array<number | null>> {
  return page.evaluate(async () => {
    const storage = await import('/src/lib/storage.ts')
    const projects = await storage.listProjects()
    const clips = await storage.getClipMetasForProject(projects[0]!.id)
    return clips.map((clip: { audioVolume?: number }) => clip.audioVolume ?? null)
  })
}

test.describe('background music', () => {
  test('free plan shows the locked Add music button and opens the Plus upsell', async ({
    page,
  }) => {
    await openSeededProject(page, { clips: 1 })
    await openEditor(page)

    const locked = page.getByRole('button', { name: /Add background music.*Plus/ })
    await expect(locked).toBeVisible()
    await locked.click()
    const sheet = page.getByRole('dialog', { name: 'Kody Video Plus' })
    await expect(sheet).toBeVisible()
    await expect(sheet).toContainText(/background music/i)
    await sheet.getByRole('button', { name: 'Not now' }).click()
    await expect(sheet).toBeHidden()
    expect(await storedAudio(page)).toBeNull()
  })

  test('adds a track, sets default and per-clip volumes, resets, and removes', async ({
    page,
  }) => {
    await openPlusEditorWithClips(page, 2)
    await addMusic(page)
    await expect(page.locator('.toast')).toContainText(/music added/i)

    const audio = await storedAudio(page)
    expect(audio?.name).toBe('test-song.wav')
    expect(audio?.durationMs).toBeGreaterThan(3000)
    expect(audio?.defaultVolume).toBeCloseTo(0.25)
    expect(audio?.size).toBeGreaterThan(1000)

    // Default volume slider persists.
    await setSlider(page, 'Default music volume', 40)
    await expect.poll(async () => (await storedAudio(page))?.defaultVolume).toBeCloseTo(0.4)

    // Per-clip override on the selected (last) clip.
    const tiles = page.locator('.clip-thumb[data-clip-id]')
    await expect(tiles.last()).toHaveClass(/selected/)
    await setSlider(page, /Music volume during clip 2/, 60)
    await expect.poll(async () => await storedClipVolumes(page)).toEqual([null, 0.6])
    // The override badge appears on the tile and the row drops "default".
    await expect(tiles.last().locator('.clip-audio-badge')).toHaveText(/60%/)

    // Selecting the other clip shows the default-following row.
    await tiles.first().click()
    await expect(page.locator('.audio-volume-label').first()).toContainText('Clip 1 · default')

    // Reset returns clip 2 to the default.
    await tiles.last().click()
    await page.getByRole('button', { name: /Reset this clip/ }).click()
    await expect.poll(async () => await storedClipVolumes(page)).toEqual([null, null])
    await expect(tiles.last().locator('.clip-audio-badge')).toHaveCount(0)

    // Remove the track entirely.
    await page.getByRole('button', { name: 'Remove background music' }).click()
    await expect(page.getByRole('button', { name: 'Add background music' })).toBeVisible()
    expect(await storedAudio(page)).toBeNull()
  })

  test('export mixes the music at per-clip volumes with ramped transitions', async ({
    page,
  }) => {
    test.slow()
    // Two 3s fixture clips (video-only — the fixture encoder adds no audio
    // track), so every decodable sample in the export's audio IS the music.
    await openPlusEditorWithClips(page, 2)

    const measured = await page.evaluate(async () => {
      const storage = await import('/src/lib/storage.ts')
      const { exportProject } = await import('/src/lib/export/index.ts')
      const { decodeBackgroundAudio } = await import('/src/lib/export/shared.ts')

      const project = (await storage.listProjects())[0]!
      const clips = await storage.getClipsForProject(project.id)

      // Synthesize a constant-amplitude sine WAV in-page as the track.
      const rate = 8000
      const seconds = 4
      const samples = rate * seconds
      const bytes = new DataView(new ArrayBuffer(44 + samples * 2))
      const writeAscii = (offset: number, text: string) => {
        for (let i = 0; i < text.length; i += 1) bytes.setUint8(offset + i, text.charCodeAt(i))
      }
      writeAscii(0, 'RIFF')
      bytes.setUint32(4, 36 + samples * 2, true)
      writeAscii(8, 'WAVE')
      writeAscii(12, 'fmt ')
      bytes.setUint32(16, 16, true)
      bytes.setUint16(20, 1, true)
      bytes.setUint16(22, 1, true)
      bytes.setUint32(24, rate, true)
      bytes.setUint32(28, rate * 2, true)
      bytes.setUint16(32, 2, true)
      bytes.setUint16(34, 16, true)
      writeAscii(36, 'data')
      bytes.setUint32(40, samples * 2, true)
      for (let i = 0; i < samples; i += 1) {
        bytes.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 16000), true)
      }
      const audio = await storage.setProjectAudio({
        projectId: project.id,
        blob: new Blob([bytes.buffer], { type: 'audio/wav' }),
        mimeType: 'audio/wav',
        durationMs: seconds * 1000,
        name: 'sine.wav',
      })
      // Clip 1 follows the 0.25 default; clip 2 is overridden to full volume.
      await storage.updateClipAudioVolume(clips[1]!.id, 1)
      const updatedClips = await storage.getClipsForProject(project.id)

      const result = await exportProject(updatedClips, {
        watermark: false,
        background: { blob: audio.blob, defaultVolume: audio.defaultVolume },
      })

      const decoded = await decodeBackgroundAudio(result.blob, 48000)
      if (!decoded) return null
      const data = decoded.getChannelData(0)
      const rms = (fromSec: number, toSec: number) => {
        const from = Math.floor(fromSec * decoded.sampleRate)
        const to = Math.min(Math.floor(toSec * decoded.sampleRate), data.length)
        let sum = 0
        for (let i = from; i < to; i += 1) sum += data[i]! * data[i]!
        return Math.sqrt(sum / Math.max(1, to - from))
      }
      return {
        durationSec: decoded.duration,
        // Steady windows away from the fade-in and the 3s boundary ramp.
        clip1: rms(1.0, 2.5),
        clip2: rms(4.0, 5.5),
        fadeIn: rms(0, 0.08),
      }
    })

    expect(measured).not.toBeNull()
    // Both clips carry audible music…
    expect(measured!.clip1).toBeGreaterThan(0.02)
    // …and the overridden clip is decisively louder (4× volume ⇒ ~4× RMS).
    expect(measured!.clip2 / measured!.clip1).toBeGreaterThan(2)
    expect(measured!.clip2 / measured!.clip1).toBeLessThan(8)
    // The film opens with the fade-in, not a full-volume slam.
    expect(measured!.fadeIn).toBeLessThan(measured!.clip1)
    expect(measured!.durationSec).toBeGreaterThan(5.5)
  })

  test('preview playback plays the music and ramps toward each clip volume', async ({
    page,
  }) => {
    await openPlusEditorWithClips(page, 2)
    await addMusic(page)

    // Clip 2 (selected) gets a louder override so the ramp is observable.
    await setSlider(page, /Music volume during clip 2/, 80)
    await expect.poll(async () => await storedClipVolumes(page)).toEqual([null, 0.8])

    await page.getByRole('button', { name: 'Play project preview' }).click()
    const overlay = page.locator('.playback-overlay')
    await expect(overlay).toBeVisible()

    const music = overlay.locator('audio')
    await expect(music).toHaveCount(1)
    // Music is playing and gliding up toward clip 1's default volume (0.25).
    await expect
      .poll(() => music.evaluate((el) => !(el as HTMLAudioElement).paused))
      .toBe(true)
    await expect
      .poll(() => music.evaluate((el) => (el as HTMLAudioElement).volume), { timeout: 5000 })
      .toBeGreaterThan(0.15)

    // Skip to clip 2: the volume glides up toward the 0.8 override.
    await overlay.getByRole('button', { name: 'Next clip' }).click()
    await expect(overlay.locator('.playback-caption')).toContainText('Clip 2 / 2')
    await expect
      .poll(() => music.evaluate((el) => (el as HTMLAudioElement).volume), { timeout: 5000 })
      .toBeGreaterThan(0.6)

    await overlay.getByRole('button', { name: 'Stop preview' }).click()
    await expect(overlay).toBeHidden()
  })
})
