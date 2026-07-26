import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetDbForTests,
  addClip,
  createProject,
  deleteClip,
  deleteProject,
  duplicateClip,
  getClip,
  getClipsForProject,
  getUndoSnapshot,
  listProjects,
  moveClip,
  renameProject,
  undoDeleteLastClip,
  updateClipTrim,
} from './storage'
import { MAX_PROJECTS, effectiveDurationMs } from './types'

function fakeBlob(label: string): Blob {
  return new Blob([label], { type: 'video/webm' })
}

describe('storage layer', () => {
  beforeEach(async () => {
    await __resetDbForTests()
  })

  it('creates and lists projects newest-first', async () => {
    const a = await createProject('Alpha')
    const b = await createProject('Beta')
    const list = await listProjects()
    expect(list.map((p) => p.id)).toEqual([b.id, a.id])
    expect(list[0]?.name).toBe('Beta')
  })

  it('enforces the soft project cap', async () => {
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
})
