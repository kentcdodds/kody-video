import { beforeEach, describe, expect, it } from 'vitest'
import {
  DB_NAME,
  __resetDbForTests,
  addClip,
  createProject,
  deleteClip,
  deleteProject,
  duplicateClip,
  getClip,
  getClipsForProject,
  getProjectAudio,
  getSettings,
  getUndoSnapshot,
  listProjects,
  moveClip,
  removeProjectAudio,
  renameProject,
  setOnboardingDismissed,
  setProjectAudio,
  toStoredBlob,
  undoDeleteLastClip,
  updateClipAudioVolume,
  updateClipTrim,
  updateProjectAudioDefaultVolume,
} from './storage'
import { markWatermarkRemoved } from './entitlement'
import { DEFAULT_AUDIO_VOLUME, MAX_PROJECTS, effectiveDurationMs } from './types'

function fakeBlob(label: string): Blob {
  return new Blob([label], { type: 'video/webm' })
}

describe('storage layer', () => {
  beforeEach(async () => {
    await __resetDbForTests()
  })

  it('uses Kody Video storage settings', async () => {
    expect(DB_NAME).toBe('kody-video')
    expect((await getSettings()).onboardingDismissed).toBe(false)

    await setOnboardingDismissed(true)

    expect((await getSettings()).onboardingDismissed).toBe(true)
  })

  it('gates the second project behind the Plus purchase', async () => {
    await createProject('Free one')
    await expect(createProject('Second')).rejects.toThrow(/plus/i)
  })

  it('creates and lists projects newest-first', async () => {
    await markWatermarkRemoved('cs_test_storage')
    const a = await createProject('Alpha')
    // createdAt ties (same-millisecond creations) make newest-first
    // ordering ambiguous — keep the assertion deterministic.
    await new Promise((resolve) => setTimeout(resolve, 2))
    const b = await createProject('Beta')
    const list = await listProjects()
    expect(list.map((p) => p.id)).toEqual([b.id, a.id])
    expect(list[0]?.name).toBe('Beta')
  })

  it('enforces the soft project cap', async () => {
    await markWatermarkRemoved('cs_test_storage')
    for (let i = 0; i < MAX_PROJECTS; i += 1) {
      await createProject(`P${i + 1}`)
    }
    await expect(createProject('Overflow')).rejects.toThrow(/limit/i)
  })

  it('renames and deletes projects, freeing clips', async () => {
    const project = await createProject('Temp')
    const clip = await addClip({
      projectId: project.id,
      blob: fakeBlob('clip-a'),
      mimeType: 'video/webm',
      durationMs: 1000,
    })
    await renameProject(project.id, 'Renamed')
    const renamed = (await listProjects())[0]
    expect(renamed?.name).toBe('Renamed')

    await deleteProject(project.id)
    expect(await listProjects()).toHaveLength(0)
    expect(await getClip(clip.id)).toBeUndefined()
  })

  it('appends clips, trims, reorders, duplicates, deletes, and undoes', async () => {
    const project = await createProject('Edit me')
    const c1 = await addClip({
      projectId: project.id,
      blob: fakeBlob('1'),
      mimeType: 'video/webm',
      durationMs: 2000,
    })
    const c2 = await addClip({
      projectId: project.id,
      blob: fakeBlob('2'),
      mimeType: 'video/webm',
      durationMs: 3000,
    })

    await updateClipTrim(c1.id, 250, 1500)
    const trimmed = await getClip(c1.id)
    expect(trimmed?.trimStartMs).toBe(250)
    expect(trimmed?.trimEndMs).toBe(1500)
    expect(effectiveDurationMs(trimmed!)).toBe(1250)

    await moveClip(project.id, c2.id, 'left')
    let clips = await getClipsForProject(project.id)
    expect(clips.map((c) => c.id)).toEqual([c2.id, c1.id])

    const copy = await duplicateClip(c2.id)
    clips = await getClipsForProject(project.id)
    expect(clips.map((c) => c.id)).toEqual([c2.id, copy.id, c1.id])
    expect(copy.blob).not.toBe(c2.blob)

    const snapshot = await deleteClip(copy.id)
    expect(snapshot?.clip.id).toBe(copy.id)
    expect(await getClip(copy.id)).toBeUndefined()
    expect((await getUndoSnapshot(project.id))?.clip.id).toBe(copy.id)

    const restored = await undoDeleteLastClip(project.id)
    expect(restored?.id).toBe(copy.id)
    expect(await getClip(copy.id)).toBeTruthy()
    clips = await getClipsForProject(project.id)
    expect(clips.map((c) => c.id)).toEqual([c2.id, copy.id, c1.id])
  })

  it('delete removes blob storage permanently when not undone', async () => {
    const project = await createProject('Gone')
    const clip = await addClip({
      projectId: project.id,
      blob: fakeBlob('bye'),
      mimeType: 'video/webm',
      durationMs: 500,
    })
    await deleteClip(clip.id)
    expect(await getClip(clip.id)).toBeUndefined()
    const remaining = await getClipsForProject(project.id)
    expect(remaining).toHaveLength(0)
  })

  it('toStoredBlob copies bytes into a fresh Blob', async () => {
    const original = fakeBlob('recorder-bytes')
    const copy = await toStoredBlob(original)
    expect(copy).not.toBe(original)
    expect(copy.type).toBe('video/webm')
    expect(await copy.text()).toBe('recorder-bytes')
  })

  it('toStoredBlob falls back to the clip mime when Blob.type is empty', async () => {
    const original = new Blob(['untyped'], { type: '' })
    const copy = await toStoredBlob(original, 'video/mp4')
    expect(copy.type).toBe('video/mp4')
    expect(await copy.text()).toBe('untyped')
  })

  it('addClip persists a durable copy, not the caller Blob reference', async () => {
    const project = await createProject('Durable')
    const original = fakeBlob('take-1')
    const clip = await addClip({
      projectId: project.id,
      blob: original,
      mimeType: 'video/webm',
      durationMs: 900,
    })
    expect(clip.blob).not.toBe(original)
    expect(await clip.blob.text()).toBe('take-1')

    const stored = await getClip(clip.id)
    expect(stored?.blob).not.toBe(original)
    expect(await stored!.blob.text()).toBe('take-1')
  })

  it('gates background music behind the Plus purchase', async () => {
    const project = await createProject('Free plan')
    await expect(
      setProjectAudio({
        projectId: project.id,
        blob: new Blob(['song'], { type: 'audio/mpeg' }),
        mimeType: 'audio/mpeg',
        durationMs: 30_000,
        name: 'song.mp3',
      }),
    ).rejects.toThrow(/plus/i)
    expect(await getProjectAudio(project.id)).toBeUndefined()
  })

  it('stores, updates, and removes a project audio track', async () => {
    await markWatermarkRemoved('cs_test_storage')
    const project = await createProject('With music')
    const audio = await setProjectAudio({
      projectId: project.id,
      blob: new Blob(['song'], { type: 'audio/mpeg' }),
      mimeType: 'audio/mpeg',
      durationMs: 30_000,
      name: 'song.mp3',
    })
    expect(audio.defaultVolume).toBe(DEFAULT_AUDIO_VOLUME)
    expect(await (await getProjectAudio(project.id))!.blob.text()).toBe('song')

    await updateProjectAudioDefaultVolume(project.id, 0.6)
    expect((await getProjectAudio(project.id))?.defaultVolume).toBe(0.6)

    // Replacing the track keeps the chosen default volume.
    const replaced = await setProjectAudio({
      projectId: project.id,
      blob: new Blob(['other'], { type: 'audio/wav' }),
      mimeType: 'audio/wav',
      durationMs: 12_000,
      name: 'other.wav',
    })
    expect(replaced.defaultVolume).toBe(0.6)

    await removeProjectAudio(project.id)
    expect(await getProjectAudio(project.id)).toBeUndefined()
  })

  it('drops the audio track when the project is deleted', async () => {
    await markWatermarkRemoved('cs_test_storage')
    const project = await createProject('Doomed')
    await setProjectAudio({
      projectId: project.id,
      blob: new Blob(['song'], { type: 'audio/mpeg' }),
      mimeType: 'audio/mpeg',
      durationMs: 30_000,
      name: 'song.mp3',
    })
    await deleteProject(project.id)
    expect(await getProjectAudio(project.id)).toBeUndefined()
  })

  it('sets, clamps, clears, and duplicates per-clip music volumes', async () => {
    const project = await createProject('Volumes')
    const clip = await addClip({
      projectId: project.id,
      blob: fakeBlob('v'),
      mimeType: 'video/webm',
      durationMs: 1000,
    })
    expect(clip.audioVolume).toBeUndefined()

    await updateClipAudioVolume(clip.id, 1.7)
    expect((await getClip(clip.id))?.audioVolume).toBe(1)

    await updateClipAudioVolume(clip.id, 0.4)
    expect((await getClip(clip.id))?.audioVolume).toBe(0.4)

    // Duplicates inherit the override.
    const copy = await duplicateClip(clip.id)
    expect((await getClip(copy.id))?.audioVolume).toBe(0.4)

    await updateClipAudioVolume(clip.id, null)
    const cleared = await getClip(clip.id)
    expect(cleared?.audioVolume).toBeUndefined()
    expect(cleared && 'audioVolume' in cleared).toBe(false)
  })

  it('does not leak AbortError unhandled rejections when a clip put fails', async () => {
    const project = await createProject('Fail put')
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      // Functions are not structured-cloneable, so IndexedDB rejects the put.
      await expect(
        addClip({
          projectId: project.id,
          blob: fakeBlob('x'),
          mimeType: 'video/webm',
          durationMs: 1000,
          lat: (() => 0) as unknown as number,
        }),
      ).rejects.toBeTruthy()
      // Let any orphaned tx.done rejection surface if the leak regresses.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const abortLeaks = unhandled.filter(
        (err) =>
          (err instanceof DOMException || err instanceof Error) && err.name === 'AbortError',
      )
      expect(abortLeaks).toHaveLength(0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
