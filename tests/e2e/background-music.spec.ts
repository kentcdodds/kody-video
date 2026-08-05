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
          fadeIn: audio.fadeIn,
          fadeOut: audio.fadeOut,
          tracks: audio.tracks.map(
            (track: {
              name: string
              durationMs: number
              blob: Blob
              trimStartMs?: number
              trimEndMs?: number
              volume?: number
              fadeIn?: boolean
              fadeOut?: boolean
            }) => ({
              name: track.name,
              durationMs: track.durationMs,
              size: track.blob.size,
              trimStartMs: track.trimStartMs ?? null,
              trimEndMs: track.trimEndMs ?? null,
              volume: track.volume ?? null,
              trackFadeIn: track.fadeIn ?? null,
              trackFadeOut: track.fadeOut ?? null,
            }),
          ),
        }
      : null
  })
}

async function storedClipVolumes(
  page: Page,
): Promise<Array<{ clipVolume: number | null; musicVolume: number | null }>> {
  return page.evaluate(async () => {
    const storage = await import('/src/lib/storage.ts')
    const projects = await storage.listProjects()
    const clips = await storage.getClipMetasForProject(projects[0]!.id)
    return clips.map((clip: { clipVolume?: number; musicVolume?: number }) => ({
      clipVolume: clip.clipVolume ?? null,
      musicVolume: clip.musicVolume ?? null,
    }))
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

  test('normalizes clip audio automatically on project load', async ({ page }) => {
    await openSeededProject(page, { clips: 2 })
    // The loader backfill measures and persists every clip's audio peak
    // (the fixture clips carry no audio track, so the stored peak is 0 —
    // "measured, mix unscaled").
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const storage = await import('/src/lib/storage.ts')
            const projects = await storage.listProjects()
            const clips = await storage.getClipMetasForProject(projects[0]!.id)
            return clips.every(
              (clip: { audioPeak?: number }) => typeof clip.audioPeak === 'number',
            )
          }),
        { timeout: 20_000 },
      )
      .toBe(true)
  })

  test('sets the clip sound volume without music (free plan)', async ({ page }) => {
    await openSeededProject(page, { clips: 1 })
    await openEditor(page)

    // The clip-sound slider lives next to the (locked) Add music button —
    // it is about the clip, not the playlist.
    await setSlider(page, 'Clip 1 sound volume', 30)
    await expect
      .poll(async () => (await storedClipVolumes(page))[0]?.clipVolume)
      .toBeCloseTo(0.3)
    await expect(page.locator('.clip-volume-badge')).toHaveText(/30%/)

    // The editor stage plays the clip at its level (no audio track in the
    // fixture clips, so the normalization scale is 1).
    await expect
      .poll(() =>
        page
          .locator('.editor-clip-preview-wrap video')
          .evaluate((el) => (el as HTMLVideoElement).volume),
      )
      .toBeCloseTo(0.3)

    // Back to 100% clears the stored override and the badge.
    await setSlider(page, 'Clip 1 sound volume', 100)
    await expect.poll(async () => (await storedClipVolumes(page))[0]?.clipVolume).toBeNull()
    await expect(page.locator('.clip-volume-badge')).toHaveCount(0)
  })

  test('builds a playlist: tracks, fades, and per-clip volumes', async ({ page }) => {
    await openPlusEditorWithClips(page, 2)
    await addMusic(page)
    await expect(page.locator('.toast')).toContainText(/music added/i)

    let audio = await storedAudio(page)
    expect(audio?.tracks.map((track: { name: string }) => track.name)).toEqual([
      'test-song.wav',
    ])
    expect(audio?.tracks[0].durationMs).toBeGreaterThan(3000)
    expect(audio?.fadeIn).toBe(true)
    expect(audio?.fadeOut).toBe(true)
    // Tracks default to the 25% volume (music under speech) — nothing is
    // stored until the detail slider changes it.
    expect(audio?.tracks[0].volume).toBeNull()
    await expect(page.locator('.audio-track-duration')).toContainText('25%')

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

    // The selected (last) clip gets two independent volume sliders, both
    // at the 100% default.
    const tiles = page.locator('.clip-thumb[data-clip-id]')
    await expect(tiles.last()).toHaveClass(/selected/)
    await expect(page.getByRole('slider', { name: 'Clip 2 sound volume' })).toHaveValue('100')
    await expect(
      page.getByRole('slider', { name: 'Music volume during clip 2' }),
    ).toHaveValue('100')

    // Duck the music under clip 2.
    await setSlider(page, 'Music volume during clip 2', 60)
    await expect.poll(async () => await storedClipVolumes(page)).toEqual([
      { clipVolume: null, musicVolume: null },
      { clipVolume: null, musicVolume: 0.6 },
    ])
    await expect(tiles.last().locator('.clip-audio-badge')).toHaveText(/60%/)

    // Quiet clip 2's own sound.
    await setSlider(page, 'Clip 2 sound volume', 40)
    await expect.poll(async () => await storedClipVolumes(page)).toEqual([
      { clipVolume: null, musicVolume: null },
      { clipVolume: 0.4, musicVolume: 0.6 },
    ])
    await expect(tiles.last().locator('.clip-volume-badge')).toHaveText(/40%/)

    // Selecting the other clip shows its own (default) dials.
    await tiles.first().click()
    await expect(page.getByRole('slider', { name: 'Clip 1 sound volume' })).toHaveValue('100')
    await expect(
      page.getByRole('slider', { name: 'Music volume during clip 1' }),
    ).toHaveValue('100')

    // Sliding back to 100% clears the stored overrides (100% IS the default).
    await tiles.last().click()
    await setSlider(page, 'Music volume during clip 2', 100)
    await setSlider(page, 'Clip 2 sound volume', 100)
    await expect.poll(async () => await storedClipVolumes(page)).toEqual([
      { clipVolume: null, musicVolume: null },
      { clipVolume: null, musicVolume: null },
    ])
    await expect(tiles.last().locator('.clip-audio-badge')).toHaveCount(0)
    await expect(tiles.last().locator('.clip-volume-badge')).toHaveCount(0)

    // Removing tracks one by one lands back on the empty Add music state —
    // the clip-sound slider stays (it is not a playlist control).
    await page.getByRole('button', { name: /Remove music track 2/ }).click()
    await expect(page.locator('.audio-track-row')).toHaveCount(1)
    await page.getByRole('button', { name: /Remove music track 1/ }).click()
    await expect(page.getByRole('button', { name: 'Add background music' })).toBeVisible()
    await expect(page.getByRole('slider', { name: 'Clip 2 sound volume' })).toBeVisible()
    await expect(page.getByRole('slider', { name: /Music volume/ })).toHaveCount(0)
    expect(await storedAudio(page)).toBeNull()
  })

  test('track detail view trims, sets volume, and fades one track', async ({ page }) => {
    await openPlusEditorWithClips(page, 1)
    await addMusic(page)

    // A track row opens its detail view — the audio counterpart of Trim.
    await page.getByRole('button', { name: /Edit music track 1/ }).click()
    const detail = page.locator('.audio-detail-strip')
    await expect(detail).toBeVisible()
    await expect(detail.locator('.trim-handle-left')).toBeVisible()
    await expect(detail.locator('.trim-handle-right')).toBeVisible()
    // The timeline, volume rows, and clip actions yield to the detail view.
    await expect(page.locator('.audio-strip')).toHaveCount(0)
    await expect(page.locator('.editor-actions')).toHaveCount(0)

    // The volume slider opens at the 25% default — the music's base level.
    await expect(detail.getByRole('slider', { name: 'Track volume' })).toHaveValue('25')

    // Escape closes it without saving.
    await page.keyboard.press('Escape')
    await expect(detail).toBeHidden()
    await expect(page.locator('.audio-strip')).toBeVisible()

    // Reopen; drag the end handle to about the middle of the 4s track.
    await page.getByRole('button', { name: /Edit music track 1/ }).click()
    const handle = detail.locator('.trim-handle-right')
    const handleBox = await handle.boundingBox()
    const trackBox = await detail.locator('.trim-strip-track').boundingBox()
    if (!handleBox || !trackBox) throw new Error('trim geometry unavailable')
    const y = handleBox.y + handleBox.height / 2
    await page.mouse.move(handleBox.x + handleBox.width / 2, y)
    await page.mouse.down()
    await page.mouse.move(trackBox.x + trackBox.width * 0.5, y, { steps: 8 })
    await page.mouse.up()
    await expect(detail.locator('.trim-kept-label')).toContainText(/kept/)

    // Volume + fades are per-track drafts, saved together on Done.
    await setSlider(page, 'Track volume', 60)
    await detail.getByRole('checkbox', { name: 'Fade this track in' }).uncheck()
    await detail.getByRole('button', { name: 'Done' }).click()
    await expect(detail).toBeHidden()

    const audio = await storedAudio(page)
    const track = audio!.tracks[0]
    expect(track.trimStartMs).toBe(0)
    expect(track.trimEndMs).not.toBeNull()
    expect(track.trimEndMs!).toBeGreaterThan(1000)
    expect(track.trimEndMs!).toBeLessThan(track.durationMs)
    expect(track.volume).toBeCloseTo(0.6)
    expect(track.trackFadeIn).toBe(false)
    expect(track.trackFadeOut).toBe(true)

    // The row reflects the kept length and volume…
    await expect(page.locator('.audio-track-duration')).toContainText(/kept · 60%/)
    // …and Cancel discards a fresh draft (the volume stays 60%).
    await page.getByRole('button', { name: /Edit music track 1/ }).click()
    await setSlider(page, 'Track volume', 20)
    await detail.getByRole('button', { name: 'Cancel' }).click()
    await expect(detail).toBeHidden()
    await expect.poll(async () => (await storedAudio(page))?.tracks[0]?.volume).toBeCloseTo(0.6)
  })

  test('export sequences the playlist at per-clip volumes with fades', async ({ page }) => {
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

      // Two in-page sine WAVs at DIFFERENT frequencies: track A (8s,
      // 110 Hz for the first 2s then 440 Hz, full amplitude, TRIMMED to
      // its 2s–6s window, at the default 25% volume) then track B (20s,
      // 880 Hz, HALF amplitude, at 50% volume). Track A's trim proves the
      // kept window is honored on both sides: the film never hears the
      // 110 Hz intro (trim start), and the hand-off to track B lands at
      // 4s (trim end — an untrimmed 8s track A would still be playing
      // 440 Hz there). Peak normalization should erase the 2× amplitude
      // difference, so the RMS ratio between the windows tracks the
      // track volumes × clip 1's music duck.
      const makeWav = (
        seconds: number,
        amplitude: number,
        freq: number,
        introFreq?: number,
      ): Blob => {
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
          const f = introFreq !== undefined && i < rate * 2 ? introFreq : freq
          bytes.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * f * i) / rate) * amplitude), true)
        }
        return new Blob([bytes.buffer], { type: 'audio/wav' })
      }
      const first = await storage.addProjectAudioTrack({
        projectId: project.id,
        blob: makeWav(8, 16000, 440, 110),
        mimeType: 'audio/wav',
        durationMs: 8000,
        name: 'track-a.wav',
      })
      // Keep track A's 2s–6s window at the default volume; explicit
      // fade-out off keeps the hand-off crisp for the windows below.
      await storage.updateProjectAudioTrack(project.id, first.tracks[0].id, {
        trimStartMs: 2000,
        trimEndMs: 6000,
        fadeOut: false,
      })
      const added = await storage.addProjectAudioTrack({
        projectId: project.id,
        blob: makeWav(20, 8000, 880),
        mimeType: 'audio/wav',
        durationMs: 20000,
        name: 'track-b.wav',
      })
      // Track B plays at 50% volume (double the 25% default); explicit
      // fade-in off keeps the post-hand-off measurement window clean.
      const audio = await storage.updateProjectAudioTrack(
        project.id,
        added.tracks[1].id,
        { volume: 0.5, fadeIn: false },
      )
      // Clip 1 ducks its music to half; clip 2 keeps the full track level.
      await storage.updateClipVolumes(clips[0]!.id, { musicVolume: 0.5 })
      const updatedClips = await storage.getClipsForProject(project.id)

      const result = await exportProject(updatedClips, {
        watermark: false,
        background: {
          tracks: audio.tracks.map(
            (track: {
              blob: Blob
              durationMs: number
              trimStartMs?: number
              trimEndMs?: number
              volume?: number
              fadeIn?: boolean
              fadeOut?: boolean
            }) => ({
              blob: track.blob,
              durationMs: track.durationMs,
              trimStartMs: track.trimStartMs,
              trimEndMs: track.trimEndMs,
              volume: track.volume,
              fadeIn: track.fadeIn,
              fadeOut: track.fadeOut,
            }),
          ),
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
        // Track A under clip 1 (music 0.25 × 0.5), past the 800ms fade-in.
        clip1: rms(1.2, 2.6),
        clip1Freq: crossingsPerSec(1.2, 2.6) / 2,
        // Track B under clip 2 (music 0.5 × 1), past the 4s hand-off,
        // before the fade-out begins at 4.8s.
        clip2: rms(4.2, 4.7),
        clip2Freq: crossingsPerSec(4.2, 4.7) / 2,
        fadeIn: rms(0, 0.08),
        fadeOut: rms(5.7, 5.95),
      }
    })

    expect(measured).not.toBeNull()
    // Clip 1 carries audible music from track A.
    expect(measured!.clip1).toBeGreaterThan(0.02)
    // Sequencing + trims: clip 1 hears track A's KEPT window (440 Hz — a
    // window starting at the file's real 0 would mix in the 110 Hz intro
    // and read far lower), and clip 2 hears track B (880 Hz) because
    // track A's trimmed end hands off at 4s (untrimmed, its 8s file
    // would still be playing 440 Hz there).
    expect(measured!.clip1Freq).toBeGreaterThan(340)
    expect(measured!.clip1Freq).toBeLessThan(540)
    expect(measured!.clip2Freq).toBeGreaterThan(700)
    expect(measured!.clip2Freq).toBeLessThan(1060)
    // Normalization + volumes: both tracks normalize to the same peak
    // despite track B being mastered at HALF the amplitude, so the RMS
    // ratio tracks (track B volume × clip 2 music) / (track A volume ×
    // clip 1 music) = (0.5 × 1) / (0.25 × 0.5) = 4. Without
    // normalization it would read ≈ 2; with the duck ignored, ≈ 2.
    expect(measured!.clip2 / measured!.clip1).toBeGreaterThan(2.7)
    expect(measured!.clip2 / measured!.clip1).toBeLessThan(5.9)
    // The film opens inside the fade-in and closes inside the fade-out.
    expect(measured!.fadeIn).toBeLessThan(measured!.clip1 * 0.5)
    expect(measured!.fadeOut).toBeLessThan(measured!.clip2 * 0.5)
    expect(measured!.durationSec).toBeGreaterThan(5.5)
  })

  test('preview playback follows the per-clip volumes independently', async ({ page }) => {
    await openPlusEditorWithClips(page, 2)
    await addMusic(page, 'Add background music', makeWavFile('test-song.wav', 8))

    const tiles = page.locator('.clip-thumb[data-clip-id]')
    // Clip 2 (selected): quiet its own sound; clip 1: duck the music.
    await setSlider(page, 'Clip 2 sound volume', 30)
    await tiles.first().click()
    await setSlider(page, 'Music volume during clip 1', 40)
    await expect.poll(async () => await storedClipVolumes(page)).toEqual([
      { clipVolume: null, musicVolume: 0.4 },
      { clipVolume: 0.3, musicVolume: null },
    ])

    await page.getByRole('button', { name: 'Play project preview' }).click()
    const overlay = page.locator('.playback-overlay')
    await expect(overlay).toBeVisible()

    const music = overlay.locator('audio')
    await expect(music).toHaveCount(1)
    await expect
      .poll(() => music.evaluate((el) => !(el as HTMLAudioElement).paused))
      .toBe(true)
    // Clip 1's music: 0.4 duck × 25% track volume × ≈2.46 normalization
    // boost ≈ 0.25 (the measurement lands in the background).
    await expect
      .poll(() => music.evaluate((el) => (el as HTMLAudioElement).volume), { timeout: 30_000 })
      .toBeGreaterThan(0.15)
    // Clip 1's own sound stays at FULL volume — a ducked music level never
    // pulls the clip down (no complement coupling).
    expect(
      await overlay.locator('.playback-video').evaluate((el) => (el as HTMLVideoElement).volume),
    ).toBeGreaterThan(0.95)

    // Skip to clip 2: the music glides up toward the undocked level
    // (0.25 × ≈2.46 ≈ 0.61) while the clip's own sound glides DOWN to its
    // 30% volume. Freeze the playhead at clip 2's start right away —
    // otherwise the end-of-film fade-out window could shrink the target
    // under CI load and flake the volume assertion.
    await overlay.getByRole('button', { name: 'Next clip' }).click()
    await expect(overlay.locator('.playback-caption')).toContainText('Clip 2 / 2')
    await overlay
      .locator('.playback-video')
      .evaluate((el) => (el as HTMLVideoElement).pause())
    await expect
      .poll(() => music.evaluate((el) => (el as HTMLAudioElement).volume), { timeout: 10_000 })
      .toBeGreaterThan(0.5)
    await expect
      .poll(
        () => overlay.locator('.playback-video').evaluate((el) => (el as HTMLVideoElement).volume),
        { timeout: 10_000 },
      )
      .toBeLessThan(0.45)

    await overlay.getByRole('button', { name: 'Stop preview' }).click()
    await expect(overlay).toBeHidden()
  })

  test('preview plays the music at the export level: peak normalization applies', async ({
    page,
  }) => {
    await openPlusEditorWithClips(page, 1)
    // Quietly mastered song: peak ≈ 8000/32768 ≈ 0.24, so the export mixes
    // it ≈ 3.7× hotter (0.9 / 0.24) than the raw file plays. The preview
    // carries the same boost in the music element's volume (25% track
    // volume × ≈3.7 ≈ 0.92) — without it the volume would sit at 0.25.
    await addMusic(page, 'Add background music', makeWavFile('quiet-song.wav', 8, 8000))

    await page.getByRole('button', { name: 'Play project preview' }).click()
    const overlay = page.locator('.playback-overlay')
    await expect(overlay).toBeVisible()

    const music = overlay.locator('audio')
    await expect
      .poll(() => music.evaluate((el) => !(el as HTMLAudioElement).paused))
      .toBe(true)
    // Freeze the playhead so the short film can't end (and its fade-out
    // window can't shrink the target) while the polls below run under load.
    await overlay
      .locator('.playback-video')
      .evaluate((el) => (el as HTMLVideoElement).pause())
    // The reported normalization scale reaches the export's boost once the
    // track is measured (decode runs in the background after open; generous
    // timeout — parallel workers can slow the decode considerably)…
    await expect
      .poll(async () => Number((await music.getAttribute('data-music-scale')) ?? '0'), {
        timeout: 30_000,
      })
      .toBeGreaterThan(3.3)
    expect(Number(await music.getAttribute('data-music-scale'))).toBeLessThanOrEqual(4)
    // …and the element volume glides to track volume × boost ≈ 0.92.
    await expect
      .poll(() => music.evaluate((el) => (el as HTMLAudioElement).volume), { timeout: 10_000 })
      .toBeGreaterThan(0.85)
    // The fixture clips (video-only, no audio track) stay unscaled,
    // exactly like the export mixes them.
    await expect(music).toHaveAttribute('data-clip-scale', '1')

    await overlay.getByRole('button', { name: 'Stop preview' }).click()
    await expect(overlay).toBeHidden()
  })

  test('editor clip preview plays the bed at the clip film position and level', async ({
    page,
  }) => {
    // Two 3s clips; the LAST one is selected by default, so its film
    // position starts at 3s — the bed must start 3s into the song, not at 0.
    await openPlusEditorWithClips(page, 2)
    await addMusic(page, 'Add background music', makeWavFile('quiet-song.wav', 8, 8000))

    const stage = page.locator('.editor-clip-preview-wrap')
    const music = stage.locator('audio')
    await expect(music).toHaveCount(1)

    await page.getByRole('button', { name: 'Play clip preview' }).click()
    await expect
      .poll(() => music.evaluate((el) => !(el as HTMLAudioElement).paused))
      .toBe(true)
    // Position: export-true playlist offset for clip 2 (≈3s into the song).
    const startedAt = await music.evaluate((el) => (el as HTMLAudioElement).currentTime)
    expect(startedAt).toBeGreaterThan(2.8)
    expect(startedAt).toBeLessThan(4.5)
    // Level: 25% track volume × ≈3.7 normalization boost ⇒ element ≈ 0.92.
    await expect
      .poll(() => music.evaluate((el) => (el as HTMLAudioElement).volume), { timeout: 30_000 })
      .toBeGreaterThan(0.85)
    // The clip's own sound is INDEPENDENT of the bed — no ducking, it
    // stays at its full (default) volume while the music plays.
    await expect
      .poll(() => stage.locator('video').evaluate((el) => (el as HTMLVideoElement).volume))
      .toBeGreaterThan(0.95)

    // When the clip stops at its trim end, the bed stops with it.
    await expect
      .poll(() => stage.locator('video').evaluate((el) => (el as HTMLVideoElement).paused), {
        timeout: 15_000,
      })
      .toBe(true)
    await expect
      .poll(() => music.evaluate((el) => (el as HTMLAudioElement).paused))
      .toBe(true)

    // Replaying after the clip ended (currentTime parked at the trim end)
    // must realign the bed to the clip's START position again — the seek
    // to the trim start happens in the same gesture that starts the bed.
    await page.getByRole('button', { name: 'Play clip preview' }).click()
    await expect
      .poll(() => music.evaluate((el) => !(el as HTMLAudioElement).paused))
      .toBe(true)
    const replayAt = await music.evaluate((el) => (el as HTMLAudioElement).currentTime)
    expect(replayAt).toBeGreaterThan(2.8)
    expect(replayAt).toBeLessThan(4.5)
  })
})
