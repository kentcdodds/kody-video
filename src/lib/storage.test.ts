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
  discardClip,
  deleteProject,
  deleteProjectIfPristine,
  duplicateClip,
  getClip,
  getClipsForProject,
  getDb,
  getProjectAudio,
  getSettings,
  getUndoSnapshot,
  isRetriableIdbFailure,
  isStaleConnectionError,
  isIndexedDbBackingStoreOpenFailure,
  IndexedDbUnavailableError,
  listProjects,
  moveClip,
  PlusRequiredError,
  removeProjectAudioTrack,
  renameProject,
  setIncludeLocationInExports,
  setLocationTaggingEnabled,
  setOnboardingDismissed,
  setProjectOrientation,
  setTourCardDismissed,
  setKeepWatermark,
  toStoredBlob,
  undoDeleteLastClip,
  updateClipAudioPeak,
  updateClipDuration,
  updateClipFit,
  updateClipSize,
  updateClipThumbs,
  updateClipVolumes,
  updateProjectAudioTrack,
  updateClipTrim,
  replaceClipMedia,
} from './storage'
import { markWatermarkRemoved } from './entitlement'
import {
  MAX_IMAGE_DURATION_MS,
  MAX_PROJECTS,
  MIN_IMAGE_DURATION_MS,
  effectiveDurationMs,
} from './types'

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

  it('recognizes Chromium IndexedDB backing-store open failures (KODY-VIDEO-Y)', () => {
    expect(
      isIndexedDbBackingStoreOpenFailure(
        new DOMException(
          'Internal error opening backing store for indexedDB.open.',
          'UnknownError',
        ),
      ),
    ).toBe(true)
    expect(
      isIndexedDbBackingStoreOpenFailure(
        new Error('UnknownError: Internal error opening backing store for indexedDB.open.'),
      ),
    ).toBe(true)
    expect(
      isIndexedDbBackingStoreOpenFailure(
        new DOMException('Error preparing Blob/File data to be stored', 'UnknownError'),
      ),
    ).toBe(false)
    expect(isIndexedDbBackingStoreOpenFailure(new Error('Clip not found'))).toBe(false)
    expect(new IndexedDbUnavailableError().name).toBe('IndexedDbUnavailableError')
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

  it('serializes overlapping mark and location pref writes', async () => {
    await markWatermarkRemoved('cs_test_pref_race')
    await Promise.all([setKeepWatermark(true), setIncludeLocationInExports(true)])
    expect(await getSettings()).toMatchObject({
      keepWatermark: true,
      includeLocationInExports: true,
    })
  })

  it('gates location capture and export preferences behind Plus', async () => {
    await expect(setLocationTaggingEnabled(true)).rejects.toBeInstanceOf(PlusRequiredError)
    await expect(setIncludeLocationInExports(true)).rejects.toBeInstanceOf(PlusRequiredError)

    await markWatermarkRemoved('cs_test_location')
    await setLocationTaggingEnabled(true)
    await setIncludeLocationInExports(true)
    expect(await getSettings()).toMatchObject({
      locationTaggingEnabled: true,
      includeLocationInExports: true,
    })

    await setLocationTaggingEnabled(false)
    await setIncludeLocationInExports(false)
    expect(await getSettings()).toMatchObject({
      locationTaggingEnabled: false,
      includeLocationInExports: false,
    })
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

  it('gates landscape orientation behind the Plus purchase', async () => {
    const project = await createProject('Free plan')
    await expect(setProjectOrientation(project.id, 'landscape')).rejects.toBeInstanceOf(
      PlusRequiredError,
    )
    await expect(setProjectOrientation(project.id, 'landscape')).rejects.toThrow(/plus/i)
    expect((await listProjects())[0]?.orientation).toBeUndefined()
    // Portrait is the default and never gated.
    await setProjectOrientation(project.id, 'portrait')
    expect((await listProjects())[0]?.orientation).toBeUndefined()
  })

  it('sets and clears the project orientation for Plus users', async () => {
    await markWatermarkRemoved('cs_test_storage')
    const project = await createProject('Widescreen')
    const landscape = await setProjectOrientation(project.id, 'landscape')
    expect(landscape.orientation).toBe('landscape')
    expect((await listProjects())[0]?.orientation).toBe('landscape')

    // Back to portrait clears the stored field entirely — indistinguishable
    // from a project made before the setting existed.
    const portrait = await setProjectOrientation(project.id, 'portrait')
    expect(portrait.orientation).toBeUndefined()
    expect('orientation' in ((await listProjects())[0] ?? {})).toBe(false)
  })

  it('stores letterbox as a clip override and clears it for crop', async () => {
    const project = await createProject('Fit')
    const clip = await addClip({
      projectId: project.id,
      blob: fakeBlob('take'),
      mimeType: 'video/webm',
      durationMs: 900,
      width: 1920,
      height: 1080,
    })
    expect(clip.fit).toBeUndefined()

    const letterboxed = await updateClipFit(clip.id, 'letterbox')
    expect(letterboxed.fit).toBe('letterbox')
    expect((await getClip(clip.id))?.fit).toBe('letterbox')

    const cropped = await updateClipFit(clip.id, 'crop')
    expect(cropped.fit).toBeUndefined()
    expect('fit' in ((await getClip(clip.id)) ?? {})).toBe(false)
  })

  it('updates stored clip display size without touching other fields', async () => {
    const project = await createProject('Size')
    const clip = await addClip({
      projectId: project.id,
      blob: fakeBlob('take'),
      mimeType: 'video/webm',
      durationMs: 900,
      width: 1080,
      height: 1920,
    })
    await updateClipSize(clip.id, 1920, 1080)
    const stored = await getClip(clip.id)
    expect(stored?.width).toBe(1920)
    expect(stored?.height).toBe(1080)
    expect(stored?.durationMs).toBe(900)
  })

  it('creates landscape projects when asked (Plus only)', async () => {
    await expect(
      createProject('Free landscape', { orientation: 'landscape' }),
    ).rejects.toBeInstanceOf(PlusRequiredError)

    await markWatermarkRemoved('cs_test_storage')
    const project = await createProject('Plus landscape', { orientation: 'landscape' })
    expect(project.orientation).toBe('landscape')
    expect((await listProjects())[0]?.orientation).toBe('landscape')
  })

  it('deleteProjectIfPristine drops an emptied project even when a lock was recorded', async () => {
    // Orientation is derived from the first take, not a standalone choice —
    // a project emptied of clips is back to its default state.
    await markWatermarkRemoved('cs_test_storage')
    const project = await createProject()
    await setProjectOrientation(project.id, 'landscape')

    expect(await deleteProjectIfPristine(project.id)).toBe(true)
    expect(await listProjects()).toHaveLength(0)
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

  it('stores a default trim-in for adopted warm recordings', async () => {
    const project = await createProject('Warm')
    const clip = await addClip({
      projectId: project.id,
      blob: fakeBlob('warm'),
      mimeType: 'video/mp4',
      durationMs: 4500,
      trimStartMs: 2300,
      trimEndMs: 4300,
    })
    expect(clip.trimStartMs).toBe(2300)
    expect(clip.trimEndMs).toBe(4300)
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

  it('replaceClipMedia swaps the blob and resets thumbs and trim', async () => {
    const project = await createProject('Bake trim')
    const clip = await addClip({
      projectId: project.id,
      blob: fakeBlob('full'),
      mimeType: 'video/webm',
      durationMs: 2000,
      lat: 1,
      lng: 2,
      clipVolume: 0.4,
    })
    await updateClipTrim(clip.id, 250, 1500)
    await updateClipThumbs(clip.id, {
      thumbs: [fakeBlob('thumb')],
      poster: fakeBlob('poster'),
      thumbWidth: 80,
      thumbHeight: 140,
    })

    const replaced = await replaceClipMedia(clip.id, {
      blob: fakeBlob('cut'),
      mimeType: 'video/webm',
      durationMs: 1250,
      width: 320,
      height: 568,
    })
    expect(replaced.durationMs).toBe(1250)
    expect(replaced.trimStartMs).toBe(0)
    expect(replaced.trimEndMs).toBe(1250)
    expect(replaced.thumbs).toBeUndefined()
    expect(replaced.poster).toBeUndefined()
    expect(replaced.audioPeak).toBeUndefined()
    expect(replaced.lat).toBe(1)
    expect(replaced.clipVolume).toBe(0.4)
    expect(await replaced.blob.text()).toBe('cut')
  })

  it('discardClip removes a clip without writing undo', async () => {
    const project = await createProject('Rollback')
    const keep = await addClip({
      projectId: project.id,
      blob: fakeBlob('keep'),
      mimeType: 'video/webm',
      durationMs: 800,
    })
    const extra = await addClip({
      projectId: project.id,
      blob: fakeBlob('extra'),
      mimeType: 'video/webm',
      durationMs: 800,
    })
    await deleteClip(keep.id)
    expect((await getUndoSnapshot(project.id))?.clip.id).toBe(keep.id)

    expect(await discardClip(extra.id)).toBe(true)
    expect(await getClip(extra.id)).toBeUndefined()
    expect((await getUndoSnapshot(project.id))?.clip.id).toBe(keep.id)
  })

  it('inserts a clip after a chosen neighbor instead of appending', async () => {
    const project = await createProject('Insert after')
    const first = await addClip({
      projectId: project.id,
      blob: fakeBlob('1'),
      mimeType: 'video/webm',
      durationMs: 1000,
    })
    const last = await addClip({
      projectId: project.id,
      blob: fakeBlob('3'),
      mimeType: 'video/webm',
      durationMs: 1000,
    })
    const middle = await addClip({
      projectId: project.id,
      blob: fakeBlob('2'),
      mimeType: 'video/webm',
      durationMs: 1000,
      afterClipId: first.id,
    })
    const clips = await getClipsForProject(project.id)
    expect(clips.map((c) => c.id)).toEqual([first.id, middle.id, last.id])
  })

  it('stores photo clips and sets their duration (grow and shrink, clamped)', async () => {
    const project = await createProject('Photos')
    const photo = await addClip({
      projectId: project.id,
      blob: new Blob(['png-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      kind: 'image',
      durationMs: 3000,
      audioPeak: 0,
    })
    expect(photo.kind).toBe('image')
    expect(photo.trimStartMs).toBe(0)
    expect(photo.trimEndMs).toBe(3000)

    // addClip itself is the storage gate: out-of-range durations clamp and
    // any supplied trim window is ignored in favor of 0..durationMs.
    const clampedIn = await addClip({
      projectId: project.id,
      blob: new Blob(['png-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      kind: 'image',
      durationMs: 1,
      trimEndMs: 250,
      audioPeak: 0,
    })
    expect(clampedIn.durationMs).toBe(MIN_IMAGE_DURATION_MS)
    expect(clampedIn.trimStartMs).toBe(0)
    expect(clampedIn.trimEndMs).toBe(MIN_IMAGE_DURATION_MS)

    const clampedOut = await addClip({
      projectId: project.id,
      blob: new Blob(['png-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      kind: 'image',
      durationMs: 10 * 60_000,
      trimEndMs: 12_000,
      audioPeak: 0,
    })
    expect(clampedOut.durationMs).toBe(MAX_IMAGE_DURATION_MS)
    expect(clampedOut.trimEndMs).toBe(MAX_IMAGE_DURATION_MS)

    // Lengthen well past the original duration — a photo has no media
    // length to trim within, so the duration is a free (clamped) choice.
    const longer = await updateClipDuration(photo.id, 12_000)
    expect(longer.durationMs).toBe(12_000)
    expect(longer.trimStartMs).toBe(0)
    expect(longer.trimEndMs).toBe(12_000)
    expect(effectiveDurationMs(longer)).toBe(12_000)

    const shorter = await updateClipDuration(photo.id, 900)
    expect(shorter.durationMs).toBe(900)
    expect(shorter.trimEndMs).toBe(900)

    // Out-of-range and unsnapped requests clamp into the supported range.
    expect((await updateClipDuration(photo.id, 1)).durationMs).toBe(MIN_IMAGE_DURATION_MS)
    expect((await updateClipDuration(photo.id, 10 * 60_000)).durationMs).toBe(
      MAX_IMAGE_DURATION_MS,
    )
    expect((await updateClipDuration(photo.id, 2_222)).durationMs).toBe(2_200)

    // Videos keep their media-bound trim semantics.
    const video = await addClip({
      projectId: project.id,
      blob: fakeBlob('video'),
      mimeType: 'video/webm',
      durationMs: 2000,
    })
    await expect(updateClipDuration(video.id, 5000)).rejects.toThrow(/photo/i)
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

  it('retries a volume write on a fresh connection when IDB dies mid-write', async () => {
    const project = await createProject('Volume retry')
    const clip = await addClip({
      projectId: project.id,
      blob: fakeBlob('volume-retry-bytes'),
      mimeType: 'video/webm',
      durationMs: 1000,
    })
    await updateClipThumbs(clip.id, {
      thumbs: [fakeBlob('thumb-one'), fakeBlob('thumb-two')],
      poster: fakeBlob('poster'),
      thumbWidth: 90,
      thumbHeight: 160,
    })

    // Kill the connection at the exact moment of the clips write — after
    // getDb()'s meta liveness probe passed — the way iOS Safari drops IDB
    // under a slider commit.
    const db = await getDb()
    const originalTransaction = db.transaction.bind(db)
    db.transaction = ((...args: Parameters<typeof db.transaction>) => {
      const names = Array.isArray(args[0]) ? args[0] : [args[0]]
      if (names.includes('clips') && args[1] === 'readwrite') {
        db.close()
      }
      return originalTransaction(...args)
    }) as typeof db.transaction

    const meta = await updateClipVolumes(clip.id, { clipVolume: 0.4 })
    expect(meta.clipVolume).toBe(0.4)

    const stored = await getClip(clip.id)
    expect(stored?.clipVolume).toBe(0.4)
    // The retry re-materializes media blobs — the bytes must survive intact.
    expect(await stored?.blob.text()).toBe('volume-retry-bytes')
    expect(await Promise.all((stored?.thumbs ?? []).map((thumb) => thumb.text()))).toEqual([
      'thumb-one',
      'thumb-two',
    ])
    expect(await stored?.poster?.text()).toBe('poster')
    expect(await getDb()).not.toBe(db)
  })

  it('a stale retry never lands after a newer volume commit for the same clip', async () => {
    const project = await createProject('Volume ordering')
    const clip = await addClip({
      projectId: project.id,
      blob: fakeBlob('v'),
      mimeType: 'video/webm',
      durationMs: 1000,
    })

    // First commit hits a dead connection and takes the slow retry path
    // (reopen + blob re-copy); the second commit follows right behind, the
    // way a slider fires. The later value must win.
    const db = await getDb()
    const originalTransaction = db.transaction.bind(db)
    db.transaction = ((...args: Parameters<typeof db.transaction>) => {
      const names = Array.isArray(args[0]) ? args[0] : [args[0]]
      if (names.includes('clips') && args[1] === 'readwrite') {
        db.close()
      }
      return originalTransaction(...args)
    }) as typeof db.transaction

    const first = updateClipVolumes(clip.id, { clipVolume: 0.45 })
    const second = updateClipVolumes(clip.id, { clipVolume: 0.3 })
    await Promise.all([first, second])

    expect((await getClip(clip.id))?.clipVolume).toBe(0.3)
  })

  it('skips the record rewrite when the committed volume is unchanged', async () => {
    const project = await createProject('Volume no-op')
    const clip = await addClip({
      projectId: project.id,
      blob: fakeBlob('v'),
      mimeType: 'video/webm',
      durationMs: 1000,
    })

    await updateClipVolumes(clip.id, { clipVolume: 0.4 })
    const updatedAt = (await listProjects()).find((p) => p.id === project.id)!.updatedAt

    // Releasing the slider on the value already stored (or clearing an
    // override that never existed) must not rewrite the whole record.
    await new Promise((resolve) => setTimeout(resolve, 5))
    await updateClipVolumes(clip.id, { clipVolume: 0.4 })
    await updateClipVolumes(clip.id, { musicVolume: 1 })
    expect((await listProjects()).find((p) => p.id === project.id)!.updatedAt).toBe(updatedAt)

    // A real change still lands and still bumps the project.
    await updateClipVolumes(clip.id, { clipVolume: 0.7 })
    expect((await getClip(clip.id))?.clipVolume).toBe(0.7)
    expect(
      (await listProjects()).find((p) => p.id === project.id)!.updatedAt,
    ).toBeGreaterThan(updatedAt)
  })

  it('classifies environmental IDB failures as retriable', () => {
    expect(
      isRetriableIdbFailure(
        new DOMException('The database connection is closing.', 'InvalidStateError'),
      ),
    ).toBe(true)
    expect(
      isRetriableIdbFailure(
        new DOMException('Error preparing Blob/File data to be stored', 'UnknownError'),
      ),
    ).toBe(true)
    expect(
      isRetriableIdbFailure(
        new DOMException(
          'Internal error opening backing store for indexedDB.open.',
          'UnknownError',
        ),
      ),
    ).toBe(true)
    expect(isRetriableIdbFailure(new DOMException('Transaction aborted', 'AbortError'))).toBe(true)
    // Hard limits and caller mistakes are not retried.
    expect(isRetriableIdbFailure(new DOMException('Quota exceeded', 'QuotaExceededError'))).toBe(
      false,
    )
    expect(isRetriableIdbFailure(new Error('Clip not found'))).toBe(false)
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
