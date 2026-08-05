import { beforeEach, describe, expect, it } from 'vitest'
import { loadHomeProjects } from './project-actions'
import { __resetDbForTests, addClip, createProject, deleteClip, listProjects, renameProject } from './storage'
import { markWatermarkRemoved } from './entitlement'

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
    await renameProject(project.id, 'Project X')

    const summaries = await loadHomeProjects()

    expect(summaries.map((entry) => entry.id)).toEqual([project.id])
    expect(summaries[0]?.clipCount).toBe(0)
  })
})
