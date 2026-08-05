import { beforeEach, describe, expect, it } from 'vitest'
import {
  DB_NAME,
  DB_VERSION,
  __resetDbForTests,
  addClip,
  addProjectAudioTrack,
  createProject,
  ProjectLimitError,
  deleteClip,
  deleteProject,
  deleteProjectIfPristine,
  duplicateClip,
  getClip,
  getClipsForProject,
  getDb,
  getProjectAudio,
  getSettings,
  getUndoSnapshot,
  isStaleConnectionError,
  listProjects,
  moveClip,
  removeProjectAudioTrack,
  renameProject,
  setOnboardingDismissed,
  setTourCardDismissed,
  setKeepWatermark,
  toStoredBlob,
  undoDeleteLastClip,
  updateClipAudioPeak,
  updateClipVolumes,
  updateProjectAudioTrack,
  updateClipTrim,
} from './storage'
import { markWatermarkRemoved } from './entitlement'
import { MAX_PROJECTS, effectiveDurationMs } from './types'

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
    expect((await getSettings()).tourCardDismissed).toBeUndefined()

    await setOnboardingDismissed(true)
    await setTourCardDismissed(true)

    expect((await getSettings()).onboardingDismissed).toBe(true)
    expect((await getSettings()).tourCardDismissed).toBe(true)
  })

  it('reopens when the cached IDB connection is closing (iOS Safari)', async () => {
    // KODY-VIDEO-F: iOS Safari closes the connection on background/navigation
    // while our module still caches the handle. close() puts the connection in
    // the "closing" state where transaction() throws InvalidStateError before
    // the close event drops the singleton — the same window getSettings hit.
    const stale = await getDb()
    stale.close()

    await expect(getSettings()).resolves.toMatchObject({ key: 'settings' })
    const reopened = await getDb()
    expect(reopened).not.toBe(stale)
    await expect(createProject('After reopen')).resolves.toMatchObject({
      name: 'After reopen',
    })
  })

  it('retries getSettings when the connection dies after the liveness probe', async () => {
    const db = await getDb()
    const originalTransaction = db.transaction.bind(db)
    let metaProbes = 0
    db.transaction = ((...args: Parameters<typeof db.transaction>) => {
      const storeNames = args[0]
      const mode = args[1]
      const names = Array.isArray(storeNames) ? storeNames : [storeNames]
      // getDb() probes with transaction('meta'); let that succeed, then close
      // before the real getSettings read — the TOCTOU CodeRabbit flagged.
      if (names.length === 1 && names[0] === 'meta' && mode === undefined) {
        metaProbes += 1
        if (metaProbes === 1) {
          const tx = originalTransaction(...args)
          db.close()
          return tx
        }
      }
      return originalTransaction(...args)
    }) as typeof db.transaction

    await expect(getSettings()).resolves.toMatchObject({ key: 'settings' })
    expect(await getDb()).not.toBe(db)
  })

  it('recognizes the IndexedDB closing/closed InvalidStateError signature', () => {
    expect(
      isStaleConnectionError(
        new DOMException(
          "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
          'InvalidStateError',
        ),
      ),
    ).toBe(true)
    expect(
      isStaleConnectionError(
        new DOMException('The database connection is closed.', 'InvalidStateError'),
      ),
    ).toBe(true)
    expect(isStaleConnectionError(new DOMException('Quota exceeded', 'QuotaExceededError'))).toBe(
      false,
    )
    expect(isStaleConnectionError(new Error('nope'))).toBe(false)
  })

  it('heals a DB left empty by a version-less open (diag-style)', async () => {
    // /api/diag used to call indexedDB.open('kody-video') with no version.
    // On a fresh origin that creates an empty version-1 database; the app's
    // oldVersion-gated upgrade then only added 'audio' and getSettings threw
    // NotFoundError for the missing 'meta' store.
    const empty = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('open failed'))
    })
    expect(empty.version).toBe(1)
    expect([...empty.objectStoreNames]).toEqual([])
    empty.close()

    const settings = await getSettings()
    expect(settings.key).toBe('settings')
    const db = await getDb()
    expect(db.version).toBe(DB_VERSION)
    expect([...db.objectStoreNames].sort()).toEqual([
      'audio',
      'clips',
      'meta',
      'projects',
      'undo',
    ])
  })

  it('heals a v2 DB that only has the audio store', async () => {
    // Simulate the post-diag corrupt state: version 2, stores = ['audio'].
    const corrupt = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2)
      req.onupgradeneeded = () => {
        req.result.createObjectStore('audio', { keyPath: 'projectId' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('open failed'))
    })
    expect([...corrupt.objectStoreNames]).toEqual(['audio'])
    corrupt.close()

    await expect(getSettings()).resolves.toMatchObject({ key: 'settings' })
    const db = await getDb()
    expect(db.version).toBe(DB_VERSION)
    expect(db.objectStoreNames.contains('meta')).toBe(true)
    expect(db.objectStoreNames.contains('projects')).toBe(true)
  })

  it('defaults keepWatermark off and persists the Plus opt-in', async () => {
    expect((await getSettings()).keepWatermark).toBeUndefined()
    await setKeepWatermark(true)
    expect((await getSettings()).keepWatermark).toBe(true)
    await setKeepWatermark(false)
    expect((await getSettings()).keepWatermark).toBe(false)
  })

  it('gates the second project behind the Plus purchase', async () => {
    await createProject('Free one')
    await expect(createProject('Second')).rejects.toBeInstanceOf(ProjectLimitError)
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
    await expect(createProject('Overflow')).rejects.toBeInstanceOf(ProjectLimitError)
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

  it('deleteProjectIfPristine removes an untouched default-state project', async () => {
    const project = await createProject()
    expect(project.name).toBe('Project 1')

    expect(await deleteProjectIfPristine(project.id)).toBe(true)
    expect(await listProjects()).toHaveLength(0)
    expect((await getSettings()).lastOpenedProjectId).toBeNull()
    // Already gone — a second attempt is a no-op.
    expect(await deleteProjectIfPristine(project.id)).toBe(false)
  })

  it('deleteProjectIfPristine drops an emptied project with its undo snapshot', async () => {
    const project = await createProject()
    const clip = await addClip({
      projectId: project.id,
      blob: fakeBlob('only-take'),
      mimeType: 'video/webm',
      durationMs: 800,
    })
    await deleteClip(clip.id)
    expect(await getUndoSnapshot(project.id)).toBeTruthy()

    expect(await deleteProjectIfPristine(project.id)).toBe(true)
    expect(await listProjects()).toHaveLength(0)
    expect(await getUndoSnapshot(project.id)).toBeUndefined()
  })

  it('deleteProjectIfPristine keeps projects with clips', async () => {
    const project = await createProject()
    await addClip({
      projectId: project.id,
      blob: fakeBlob('keeper'),
      mimeType: 'video/webm',
      durationMs: 800,
    })

    expect(await deleteProjectIfPristine(project.id)).toBe(false)
    expect(await listProjects()).toHaveLength(1)
  })

  it('deleteProjectIfPristine keeps renamed projects', async () => {
    const project = await createProject()
    await renameProject(project.id, 'Ski trip')

    expect(await deleteProjectIfPristine(project.id)).toBe(false)
    expect((await listProjects())[0]?.name).toBe('Ski trip')
  })

  it('deleteProjectIfPristine keeps a project renamed to a default-shaped name', async () => {
    const project = await createProject()
    await renameProject(project.id, 'Project 2')

    expect(await deleteProjectIfPristine(project.id)).toBe(false)
    expect((await listProjects())[0]?.name).toBe('Project 2')
  })

  it('deleteProjectIfPristine keeps a project created with a default-shaped name', async () => {
    const project = await createProject('Project 2')

    expect(await deleteProjectIfPristine(project.id)).toBe(false)
    expect(await listProjects()).toHaveLength(1)
  })

  it('deleteProjectIfPristine keeps projects with background music', async () => {
    await markWatermarkRemoved('cs_test_storage')
    const project = await createProject()
    await addProjectAudioTrack({
      projectId: project.id,
      blob: new Blob(['song'], { type: 'audio/mpeg' }),
      mimeType: 'audio/mpeg',
      durationMs: 30_000,
      name: 'song.mp3',
    })

    expect(await deleteProjectIfPristine(project.id)).toBe(false)
    expect(await listProjects()).toHaveLength(1)
  })

  it('stores a default trim-out at the requested point, clamped to the media', async () => {
    const project = await createProject('Grace')
    // Recordings pass the release point; the media runs a stop-grace longer.
    const clip = await addClip({
      projectId: project.id,
      blob: fakeBlob('graced'),
      mimeType: 'video/webm',
      durationMs: 2200,
      trimEndMs: 2000,
    })
    expect(clip.trimStartMs).toBe(0)
    expect(clip.trimEndMs).toBe(2000)
    expect(clip.durationMs).toBe(2200)

    const clamped = await addClip({
      projectId: project.id,
      blob: fakeBlob('clamped'),
      mimeType: 'video/webm',
      durationMs: 1000,
      trimEndMs: 5000,
    })
    expect(clamped.trimEndMs).toBe(1000)
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
      addProjectAudioTrack({
        projectId: project.id,
        blob: new Blob(['song'], { type: 'audio/mpeg' }),
        mimeType: 'audio/mpeg',
        durationMs: 30_000,
        name: 'song.mp3',
      }),
    ).rejects.toThrow(/plus/i)
    expect(await getProjectAudio(project.id)).toBeUndefined()
  })

  it('builds a playlist of sequential tracks with shared settings', async () => {
    await markWatermarkRemoved('cs_test_storage')
    const project = await createProject('With music')
    const first = await addProjectAudioTrack({
      projectId: project.id,
      blob: new Blob(['song'], { type: 'audio/mpeg' }),
      mimeType: 'audio/mpeg',
      durationMs: 30_000,
      name: 'song.mp3',
    })
    expect(first.fadeIn).toBe(true)
    expect(first.fadeOut).toBe(true)
    expect(first.tracks).toHaveLength(1)
    expect(await first.tracks[0].blob.text()).toBe('song')

    // A second track appends and keeps the playlist settings.
    const second = await addProjectAudioTrack({
      projectId: project.id,
      blob: new Blob(['other'], { type: 'audio/wav' }),
      mimeType: 'audio/wav',
      durationMs: 12_000,
      name: 'other.wav',
    })
    expect(second.tracks.map((track) => track.name)).toEqual(['song.mp3', 'other.wav'])
    expect(second.fadeIn).toBe(true)
    expect(second.fadeOut).toBe(true)

    // Removing one track keeps the playlist; removing the last drops it.
    let audio = await getProjectAudio(project.id)
    expect(audio?.tracks).toHaveLength(2)
    await removeProjectAudioTrack(project.id, second.tracks[0].id)
    audio = await getProjectAudio(project.id)
    expect(audio?.tracks.map((track) => track.name)).toEqual(['other.wav'])
    await removeProjectAudioTrack(project.id, audio!.tracks[0].id)
    expect(await getProjectAudio(project.id)).toBeUndefined()
  })

  it('updates one track\u2019s playback settings with clamped trim and level', async () => {
    await markWatermarkRemoved('cs_test_storage')
    const project = await createProject('Track settings')
    const record = await addProjectAudioTrack({
      projectId: project.id,
      blob: new Blob(['song'], { type: 'audio/mpeg' }),
      mimeType: 'audio/mpeg',
      durationMs: 30_000,
      name: 'song.mp3',
    })
    const trackId = record.tracks[0].id

    const updated = await updateProjectAudioTrack(project.id, trackId, {
      trimStartMs: 2_000,
      trimEndMs: 45_000,
      volume: 0.6,
      fadeIn: false,
    })
    expect(updated.tracks[0]).toMatchObject({
      trimStartMs: 2_000,
      trimEndMs: 30_000,
      volume: 0.6,
      fadeIn: false,
    })
    // Untouched fields survive; fadeOut still inherits from the playlist.
    expect(updated.tracks[0].fadeOut).toBeUndefined()

    // Partial updates keep the other side of the trim window, and the end
    // can never cross the start.
    const nudged = await updateProjectAudioTrack(project.id, trackId, { trimEndMs: 1_000 })
    expect(nudged.tracks[0].trimStartMs).toBe(2_000)
    expect(nudged.tracks[0].trimEndMs).toBe(2_000)

    // Non-finite trim requests keep the stored values — NaN never persists.
    const junkTrim = await updateProjectAudioTrack(project.id, trackId, {
      trimStartMs: Number.NaN,
      trimEndMs: 10_000,
    })
    expect(junkTrim.tracks[0].trimStartMs).toBe(2_000)
    expect(junkTrim.tracks[0].trimEndMs).toBe(10_000)
    await updateProjectAudioTrack(project.id, trackId, { trimEndMs: 1_000 })

    // The volume clamps to 0–1 and junk falls back to the default (the
    // stored value is dropped, so audioTrackLevel resolves the default).
    expect(
      (await updateProjectAudioTrack(project.id, trackId, { volume: 7 })).tracks[0].volume,
    ).toBe(1)
    expect(
      (await updateProjectAudioTrack(project.id, trackId, { volume: Number.NaN })).tracks[0]
        .volume,
    ).toBeUndefined()

    // The settings persist.
    const stored = await getProjectAudio(project.id)
    expect(stored?.tracks[0]).toMatchObject({ trimStartMs: 2_000, trimEndMs: 2_000 })
    expect(stored?.tracks[0].volume).toBeUndefined()

    await expect(
      updateProjectAudioTrack(project.id, 'missing-track', { volume: 0.5 }),
    ).rejects.toThrow(/track not found/i)
    const empty = await createProject('No music yet')
    await expect(
      updateProjectAudioTrack(empty.id, trackId, { volume: 0.5 }),
    ).rejects.toThrow(/no background music/i)
  })

  it('drops the audio playlist when the project is deleted', async () => {
    await markWatermarkRemoved('cs_test_storage')
    const project = await createProject('Doomed')
    await addProjectAudioTrack({
      projectId: project.id,
      blob: new Blob(['song'], { type: 'audio/mpeg' }),
      mimeType: 'audio/mpeg',
      durationMs: 30_000,
      name: 'song.mp3',
    })
    await deleteProject(project.id)
    expect(await getProjectAudio(project.id)).toBeUndefined()
  })

  it('sets, clamps, clears, and duplicates per-clip volumes', async () => {
    const project = await createProject('Volumes')
    const clip = await addClip({
      projectId: project.id,
      blob: fakeBlob('v'),
      mimeType: 'video/webm',
      durationMs: 1000,
    })
    expect(clip.clipVolume).toBeUndefined()
    expect(clip.musicVolume).toBeUndefined()

    // Full volume is the default — values ≥ 1 store no override.
    await updateClipVolumes(clip.id, { clipVolume: 1.7 })
    expect((await getClip(clip.id))?.clipVolume).toBeUndefined()

    await updateClipVolumes(clip.id, { clipVolume: 0.4 })
    expect((await getClip(clip.id))?.clipVolume).toBe(0.4)

    // Each side updates independently; the other is left as is.
    await updateClipVolumes(clip.id, { musicVolume: 0.6 })
    const both = await getClip(clip.id)
    expect(both?.clipVolume).toBe(0.4)
    expect(both?.musicVolume).toBe(0.6)

    // Duplicates inherit the overrides.
    const copy = await duplicateClip(clip.id)
    expect((await getClip(copy.id))?.clipVolume).toBe(0.4)
    expect((await getClip(copy.id))?.musicVolume).toBe(0.6)

    await updateClipVolumes(clip.id, { clipVolume: null, musicVolume: 1 })
    const cleared = await getClip(clip.id)
    expect(cleared?.clipVolume).toBeUndefined()
    expect(cleared && 'clipVolume' in cleared).toBe(false)
    expect(cleared && 'musicVolume' in cleared).toBe(false)
  })

  it('persists the measured audio peak without touching updatedAt', async () => {
    const project = await createProject('Peaks')
    const clip = await addClip({
      projectId: project.id,
      blob: fakeBlob('p'),
      mimeType: 'video/webm',
      durationMs: 1000,
    })
    expect(clip.audioPeak).toBeUndefined()
    const updatedAtBefore = (await listProjects()).find((p) => p.id === project.id)!.updatedAt

    await updateClipAudioPeak(clip.id, 0.45)
    expect((await getClip(clip.id))?.audioPeak).toBe(0.45)

    // Junk clamps into 0–1 (never poisons playback math).
    await updateClipAudioPeak(clip.id, Number.NaN)
    expect((await getClip(clip.id))?.audioPeak).toBe(0)

    // A measurement is not a user edit — home slot order must not churn.
    const updatedAtAfter = (await listProjects()).find((p) => p.id === project.id)!.updatedAt
    expect(updatedAtAfter).toBe(updatedAtBefore)

    // A missing clip is a no-op, not an error (deleted mid-backfill).
    await expect(updateClipAudioPeak('missing-clip', 0.5)).resolves.toBeUndefined()
  })

  it('does not leak AbortError unhandled rejections when a clip put fails', async () => {
    const project = await createProject('Fail put')
    const unhandled: unknown[] = []
    const onUnhandled = (event: PromiseRejectionEvent) => {
      unhandled.push(event.reason)
      event.preventDefault()
    }
    window.addEventListener('unhandledrejection', onUnhandled)
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
      // Chromium fires unhandledrejection a task after the rejection, so
      // yield through two macrotasks before judging.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const abortLeaks = unhandled.filter(
        (err) =>
          (err instanceof DOMException || err instanceof Error) && err.name === 'AbortError',
      )
      expect(abortLeaks).toHaveLength(0)
    } finally {
      window.removeEventListener('unhandledrejection', onUnhandled)
    }
  })
})
