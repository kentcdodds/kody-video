import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendRecording, loadHomeProjects } from './project-actions'
import { __resetDbForTests, addClip, createProject, deleteClip, getProject, listProjects, renameProject } from './storage'
import { markWatermarkRemoved } from './entitlement'
import { setPlatformOverridesForTests } from './platform'

function fakeBlob(label: string): Blob {
  return new Blob([label], { type: 'video/webm' })
}

describe('loadHomeProjects', () => {
  beforeEach(async () => {
    await __resetDbForTests()
  })

  it('silently deletes projects left in their default state', async () => {
    await markWatermarkRemoved('cs_test_actions')
    const kept = await createProject('Ski trip')
    const pristine = await createProject()
    const emptied = await createProject()
    const clip = await addClip({
      projectId: emptied.id,
      blob: fakeBlob('take'),
      mimeType: 'video/webm',
      durationMs: 700,
    })
    await deleteClip(clip.id)

    const summaries = await loadHomeProjects()

    expect(summaries.map((project) => project.id)).toEqual([kept.id])
    expect((await listProjects()).map((project) => project.id)).toEqual([kept.id])
    expect(pristine.name).toBe('Project 2')
  })

  it('keeps empty projects the user renamed', async () => {
    const project = await createProject()
    // Even a rename to a default-shaped name is deliberate.
    await renameProject(project.id, 'Project 2')

    const summaries = await loadHomeProjects()

    expect(summaries.map((entry) => entry.id)).toEqual([project.id])
    expect(summaries[0]?.clipCount).toBe(0)
  })
})

describe('appendRecording orientation lock', () => {
  beforeEach(async () => {
    await __resetDbForTests()
  })

  afterEach(() => {
    setPlatformOverridesForTests({})
  })

  const record = (projectId: string, label: string) =>
    appendRecording(projectId, {
      blob: fakeBlob(label),
      mimeType: 'video/webm',
      durationMs: 900,
    })

  it('locks landscape from the first take on a sideways-held touch device', async () => {
    await markWatermarkRemoved('cs_test_actions')
    setPlatformOverridesForTests({ coarsePointer: true, viewportLandscape: true })
    const project = await createProject('Wide')

    await record(project.id, 'first')
    expect((await getProject(project.id))?.orientation).toBe('landscape')

    // Later takes never re-decide.
    setPlatformOverridesForTests({ coarsePointer: true, viewportLandscape: false })
    await record(project.id, 'second')
    expect((await getProject(project.id))?.orientation).toBe('landscape')
  })

  it('locks portrait (overwriting a stale lock) from an upright first take', async () => {
    await markWatermarkRemoved('cs_test_actions')
    setPlatformOverridesForTests({ coarsePointer: true, viewportLandscape: true })
    const project = await createProject('Tall')
    const first = await record(project.id, 'wide-take')
    await deleteClip(first.id)
    // Deleting the last clip deliberately KEEPS the stored lock: clearing it
    // here would lose the orientation across a delete → undo cycle. An empty
    // project is unlocked because the UI derives that from clip count, and
    // the next first take overwrites the stale value (asserted below).
    expect((await getProject(project.id))?.orientation).toBe('landscape')

    // Emptied project: the next first take re-decides — now held upright.
    setPlatformOverridesForTests({ coarsePointer: true, viewportLandscape: false })
    await record(project.id, 'upright-take')
    // Stored explicitly: a portrait LOCK pins the interface and forces the
    // export's shape, which a project that never locked one must not.
    expect((await getProject(project.id))?.orientation).toBe('portrait')
  })

  it('never locks on fine-pointer (desktop) devices', async () => {
    setPlatformOverridesForTests({ coarsePointer: false, viewportLandscape: true })
    const project = await createProject('Desk')

    await record(project.id, 'webcam')
    expect((await getProject(project.id))?.orientation).toBeUndefined()
  })

  it('saves the take even when the landscape lock is entitlement-gated', async () => {
    // Free plan: the record screen blocks landscape takes up front, but if
    // one ever reaches the save path the clip must land and the project
    // simply stays unlocked.
    setPlatformOverridesForTests({ coarsePointer: true, viewportLandscape: true })
    const project = await createProject('Free wide')

    const clip = await record(project.id, 'take')
    expect(clip.id).toBeTruthy()
    const stored = await getProject(project.id)
    expect(stored?.clipIds).toHaveLength(1)
    expect(stored?.orientation).toBeUndefined()
  })
})
