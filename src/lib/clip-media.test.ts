import { beforeEach, describe, expect, it } from 'vitest'
import { permanentlyTrimClip, splitSelectedClip } from './project-actions'
import { __resetDbForTests, addClip, createProject, getClip, getClipsForProject, updateClipTrim } from './storage'
import { makeTestClipBlob } from './testing/make-test-clip'
import { sliceClipMedia } from './clip-media'
import { measureBlobDuration } from './media'

describe('sliceClipMedia', () => {
  it('encodes a shorter file for a kept window', async () => {
    const source = await makeTestClipBlob(1200)
    const sliced = await sliceClipMedia(source, 200, 800)
    expect(sliced.blob.size).toBeGreaterThan(0)
    expect(sliced.mimeType).toMatch(/webm|mp4/)
    expect(sliced.durationMs).toBeGreaterThanOrEqual(400)
    expect(sliced.durationMs).toBeLessThan(1000)
    await expect(measureBlobDuration(sliced.blob)).resolves.toBeGreaterThan(300)
  })
})

describe('permanentlyTrimClip / splitSelectedClip', () => {
  beforeEach(async () => {
    await __resetDbForTests()
  })

  it('bakes the saved trim into a new blob and resets the window', async () => {
    const project = await createProject('Cut')
    const blob = await makeTestClipBlob(1200)
    const clip = await addClip({
      projectId: project.id,
      blob,
      mimeType: 'video/webm',
      durationMs: 1200,
      width: 320,
      height: 568,
    })
    await updateClipTrim(clip.id, 200, 800)

    const updated = await permanentlyTrimClip(clip.id)
    expect(updated.durationMs).toBeGreaterThanOrEqual(400)
    expect(updated.durationMs).toBeLessThan(1000)
    expect(updated.trimStartMs).toBe(0)
    expect(updated.trimEndMs).toBe(updated.durationMs)
    expect(updated.blob.size).toBeGreaterThan(0)
    expect(updated.blob.size).not.toBe(blob.size)
  })

  it('splits one clip into two adjacent pieces', async () => {
    const project = await createProject('Split')
    const blob = await makeTestClipBlob(1200)
    const clip = await addClip({
      projectId: project.id,
      blob,
      mimeType: 'video/webm',
      durationMs: 1200,
      width: 320,
      height: 568,
    })

    const { first, second } = await splitSelectedClip(clip.id, 600)
    expect(first.id).toBe(clip.id)
    expect(second.id).not.toBe(clip.id)
    expect(first.durationMs).toBeGreaterThan(200)
    expect(second.durationMs).toBeGreaterThan(200)
    expect(first.durationMs + second.durationMs).toBeGreaterThan(800)

    const ordered = await getClipsForProject(project.id)
    expect(ordered.map((item) => item.id)).toEqual([first.id, second.id])
    expect(await getClip(second.id)).toBeTruthy()
  })
})
