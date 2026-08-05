import { test, expect, type Page } from '@playwright/test'
import {
  openSeededProject,
  seedProject,
  unlockPlus,
  waitForCameraReady,
} from './helpers'

/** Tiny mono 16-bit PCM WAV — decodable everywhere, generated in-test. */
function makeWavFile(name: string, durationSec = 4, amplitude = 12000, freq = 440) {
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
    buffer.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amplitude),
      44 + i * 2,
    )
  }
  return { name, mimeType: 'audio/wav', buffer }
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

async function addMusic(
  page: Page,
  buttonName: string | RegExp = 'Add background music',
  file = makeWavFile('test-song.wav'),
): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: buttonName }).click()
  const chooser = await chooserPromise
  await chooser.setFiles(file)
  await expect(page.locator('.audio-track-name').filter({ hasText: file.name })).toBeVisible({
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
          defaultVolume: audio.defaultVolume,
          fadeIn: audio.fadeIn,
          fadeOut: audio.fadeOut,
          tracks: audio.tracks.map(
            (track: { name: string; durationMs: number; blob: Blob }) => ({
              name: track.name,
              durationMs: track.durationMs,
              size: track.blob.size,
            }),
          ),
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

  test('builds a playlist: tracks, fades, default and per-clip volumes', async ({ page }) => {
    await openPlusEditorWithClips(page, 2)
    await addMusic(page)
    await expect(page.locator('.toast')).toContainText(/music added/i)

    let audio = await storedAudio(page)
    expect(audio?.tracks.map((track: { name: string }) => track.name)).toEqual([
      'test-song.wav',
    ])
    expect(audio?.tracks[0].durationMs).toBeGreaterThan(3000)
    expect(audio?.defaultVolume).toBeCloseTo(0.25)
    expect(audio?.fadeIn).toBe(true)
    expect(audio?.fadeOut).toBe(true)

    // 4s of music under a 6s film: the coverage hint appears…
    await expect(page.locator('.audio-coverage-hint')).toContainText(/music ends at/i)
    // …until a second track covers the rest.
    await addMusic(page, 'Add another music track', makeWavFile('second-song.wav', 6))
    await expect(page.locator('.audio-track-row')).toHaveCount(2)
    await expect(page.locator('.audio-coverage-hint')).toHaveCount(0)
    audio = await storedAudio(page)
    expect(audio?.tracks.map((track: { name: string }) => track.name)).toEqual([
      'test-song.wav',
      'second-song.wav',
    ])

    // Fade toggles persist (default on).
    await page.getByRole('checkbox', { name: /Fade the music in/ }).uncheck()
    await expect.poll(async () => (await storedAudio(page))?.fadeIn).toBe(false)
    await expect.poll(async () => (await storedAudio(page))?.fadeOut).toBe(true)

    // Default mix slider persists (value = music's share).
    await setSlider(page, 'Default audio mix', 40)
    await expect.poll(async () => (await storedAudio(page))?.defaultVolume).toBeCloseTo(0.4)

    // Per-clip override on the selected (last) clip. The row shows both
    // sides of the balance: clip sound left, music right.
    const tiles = page.locator('.clip-thumb[data-clip-id]')
    await expect(tiles.last()).toHaveClass(/selected/)
    await setSlider(page, /Audio mix during clip 2/, 60)
    await expect.poll(async () => await storedClipVolumes(page)).toEqual([null, 0.6])
    await expect(tiles.last().locator('.clip-audio-badge')).toHaveText(/60%/)
    const clipMixRow = page.locator('.audio-mix-row').first()
    await expect(clipMixRow).toContainText('Clip 40%')
    await expect(clipMixRow).toContainText('60% Music')

    // Selecting the other clip shows the default-following row.
    await tiles.first().click()
    await expect(page.locator('.audio-volume-label').first()).toContainText('Clip 1 · default')

    // Reset returns clip 2 to the default.
    await tiles.last().click()
    await page.getByRole('button', { name: /Reset this clip/ }).click()
    await expect.poll(async () => await storedClipVolumes(page)).toEqual([null, null])
    await expect(tiles.last().locator('.clip-audio-badge')).toHaveCount(0)

    // Removing tracks one by one lands back on the empty Add music state.
    await page.getByRole('button', { name: /Remove music track 2/ }).click()
    await expect(page.locator('.audio-track-row')).toHaveCount(1)
    await page.getByRole('button', { name: /Remove music track 1/ }).click()
    await expect(page.getByRole('button', { name: 'Add background music' })).toBeVisible()
    expect(await storedAudio(page)).toBeNull()
  })

  test('export sequences the playlist at per-clip mixes with fades', async ({ page }) => {
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

      // Two in-page sine WAVs at DIFFERENT frequencies: track A (4s,
      // 440 Hz, full amplitude) then track B (20s, 880 Hz, HALF
      // amplitude). The frequency step at the 4s hand-off proves
      // sequential playback (a looping track A would keep 440 Hz), and
      // peak normalization should erase the 2× amplitude difference —
      // making the RMS ratio between the windows track the mix shares
      // alone.
      const makeWav = (seconds: number, amplitude: number, freq: number): Blob => {
        const rate = 8000
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
          bytes.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amplitude), true)
        }
        return new Blob([bytes.buffer], { type: 'audio/wav' })
      }
      await storage.addProjectAudioTrack({
        projectId: project.id,
        blob: makeWav(4, 16000, 440),
        mimeType: 'audio/wav',
        durationMs: 4000,
        name: 'track-a.wav',
      })
      const audio = await storage.addProjectAudioTrack({
        projectId: project.id,
        blob: makeWav(20, 8000, 880),
        mimeType: 'audio/wav',
        durationMs: 20000,
        name: 'track-b.wav',
      })
      // Clip 1 follows the 0.25 default; clip 2 is overridden to full volume.
      await storage.updateClipAudioVolume(clips[1]!.id, 1)
      const updatedClips = await storage.getClipsForProject(project.id)

      const result = await exportProject(updatedClips, {
        watermark: false,
        background: {
          tracks: audio.tracks.map((track: { blob: Blob }) => ({ blob: track.blob })),
          defaultVolume: audio.defaultVolume,
          fadeIn: audio.fadeIn,
          fadeOut: audio.fadeOut,
        },
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
      // Dominant frequency proxy: sign changes per second (~2× frequency).
      const crossingsPerSec = (fromSec: number, toSec: number) => {
        const from = Math.floor(fromSec * decoded.sampleRate)
        const to = Math.min(Math.floor(toSec * decoded.sampleRate), data.length)
        let crossings = 0
        for (let i = from + 1; i < to; i += 1) {
          if (data[i - 1]! < 0 !== data[i]! < 0) crossings += 1
        }
        return crossings / Math.max(0.001, toSec - fromSec)
      }
      return {
        durationSec: decoded.duration,
        // Track A under clip 1 (music share 0.25), past the 800ms fade-in.
        clip1: rms(1.2, 2.6),
        clip1Freq: crossingsPerSec(1.2, 2.6) / 2,
        // Track B under clip 2 (share 1.0), past the 4s hand-off, before
        // the fade-out begins at 4.8s.
        clip2: rms(4.2, 4.7),
        clip2Freq: crossingsPerSec(4.2, 4.7) / 2,
        fadeIn: rms(0, 0.08),
        fadeOut: rms(5.7, 5.95),
      }
    })

    expect(measured).not.toBeNull()
    // Clip 1 carries audible music from track A.
    expect(measured!.clip1).toBeGreaterThan(0.02)
    // Sequencing: clip 1 hears track A (440 Hz), clip 2 hears track B
    // (880 Hz) — a looping track A would keep 440 Hz after the hand-off.
    expect(measured!.clip1Freq).toBeGreaterThan(340)
    expect(measured!.clip1Freq).toBeLessThan(540)
    expect(measured!.clip2Freq).toBeGreaterThan(700)
    expect(measured!.clip2Freq).toBeLessThan(1060)
    // Normalization + mix shares: both tracks normalize to the same peak
    // despite track B being mastered at HALF the amplitude, so the RMS
    // ratio tracks the shares alone (1.0 / 0.25 ≈ 4). Without
    // normalization it would read ≈ 2.
    expect(measured!.clip2 / measured!.clip1).toBeGreaterThan(2.8)
    expect(measured!.clip2 / measured!.clip1).toBeLessThan(5.5)
    // The film opens inside the fade-in and closes inside the fade-out.
    expect(measured!.fadeIn).toBeLessThan(measured!.clip1 * 0.5)
    expect(measured!.fadeOut).toBeLessThan(measured!.clip2 * 0.5)
    expect(measured!.durationSec).toBeGreaterThan(5.5)
  })

  test('preview playback ramps both sides of the mix per clip', async ({ page }) => {
    await openPlusEditorWithClips(page, 2)
    await addMusic(page)

    // Clip 2 (selected) gets a music-heavy override so the ramp is observable.
    await setSlider(page, /Audio mix during clip 2/, 80)
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

    // Skip to clip 2: the volume glides up toward the 0.8 override. Freeze
    // the playhead at clip 2's start right away — otherwise the end-of-film
    // fade-out window could shrink the target under CI load and flake the
    // volume assertion.
    await overlay.getByRole('button', { name: 'Next clip' }).click()
    await expect(overlay.locator('.playback-caption')).toContainText('Clip 2 / 2')
    await overlay
      .locator('.playback-video')
      .evaluate((el) => (el as HTMLVideoElement).pause())
    await expect
      .poll(() => music.evaluate((el) => (el as HTMLAudioElement).volume), { timeout: 5000 })
      .toBeGreaterThan(0.6)
    // …and the clip's own sound ducks toward the complement (1 − 0.8).
    await expect
      .poll(
        () => overlay.locator('.playback-video').evaluate((el) => (el as HTMLVideoElement).volume),
        { timeout: 5000 },
      )
      .toBeLessThan(0.35)

    await overlay.getByRole('button', { name: 'Stop preview' }).click()
    await expect(overlay).toBeHidden()
  })

  test('preview plays the music at the export level: peak normalization applies', async ({
    page,
  }) => {
    await openPlusEditorWithClips(page, 1)
    // Quietly mastered song: peak ≈ 8000/32768 ≈ 0.24, so the export mixes
    // it ≈ 3.7× hotter (0.9 / 0.24) than the raw file plays. The preview
    // must apply the same boost — element volume alone caps at 1×.
    await addMusic(page, 'Add background music', makeWavFile('quiet-song.wav', 8, 8000))

    await page.getByRole('button', { name: 'Play project preview' }).click()
    const overlay = page.locator('.playback-overlay')
    await expect(overlay).toBeVisible()

    const music = overlay.locator('audio')
    await expect
      .poll(() => music.evaluate((el) => !(el as HTMLAudioElement).paused))
      .toBe(true)
    // The music gain glides to the export's normalization boost once the
    // track is measured (decode runs in the background after open; generous
    // timeout — parallel workers can slow the decode considerably)…
    await expect
      .poll(async () => Number((await music.getAttribute('data-music-scale')) ?? '0'), {
        timeout: 30_000,
      })
      .toBeGreaterThan(3.3)
    expect(Number(await music.getAttribute('data-music-scale'))).toBeLessThanOrEqual(4)
    // …while the fixture clips (video-only, no audio track) stay unscaled,
    // exactly like the export mixes them.
    await expect(music).toHaveAttribute('data-clip-scale', '1')

    await overlay.getByRole('button', { name: 'Stop preview' }).click()
    await expect(overlay).toBeHidden()
  })
})
