import { beforeEach, describe, expect, it } from 'vitest'
import {
  importDeviceClips,
  isLikelyVideoFile,
  mimeTypeForDeviceFile,
  probeDeviceClip,
} from './import-device-clips'
import { __resetDbForTests, createProject, getClipsForProject } from './storage'

describe('mimeTypeForDeviceFile', () => {
  it('prefers an explicit video MIME type', () => {
    expect(mimeTypeForDeviceFile({ name: 'clip.mov', type: 'video/mp4' })).toBe('video/mp4')
  })

  it('infers from common extensions when type is empty', () => {
    expect(mimeTypeForDeviceFile({ name: 'Take 01.MP4', type: '' })).toBe('video/mp4')
    expect(mimeTypeForDeviceFile({ name: 'clip.m4v', type: '' })).toBe('video/mp4')
    expect(mimeTypeForDeviceFile({ name: 'clip.webm', type: '' })).toBe('video/webm')
    expect(mimeTypeForDeviceFile({ name: 'clip.mov', type: '' })).toBe('video/quicktime')
    expect(mimeTypeForDeviceFile({ name: 'clip.mkv', type: '' })).toBe('video/x-matroska')
  })

  it('falls back to mp4 for extension-less gallery picks', () => {
    expect(mimeTypeForDeviceFile({ name: 'content', type: '' })).toBe('video/mp4')
  })
})

describe('isLikelyVideoFile', () => {
  it('accepts video/* and ambiguous gallery picks', () => {
    expect(isLikelyVideoFile({ name: 'a.bin', type: 'video/webm' })).toBe(true)
    expect(isLikelyVideoFile({ name: 'a.mp4', type: '' })).toBe(true)
    expect(isLikelyVideoFile({ name: 'a.MOV', type: 'application/octet-stream' })).toBe(true)
    // Android content URIs often lack both a useful type and an extension.
    expect(isLikelyVideoFile({ name: 'content', type: '' })).toBe(true)
    expect(isLikelyVideoFile({ name: 'content', type: 'application/octet-stream' })).toBe(true)
  })

  it('rejects obvious non-video types', () => {
    expect(isLikelyVideoFile({ name: 'photo.jpg', type: 'image/jpeg' })).toBe(false)
    expect(isLikelyVideoFile({ name: 'notes.txt', type: 'text/plain' })).toBe(false)
  })
})

describe('probeDeviceClip / importDeviceClips', () => {
  beforeEach(async () => {
    await __resetDbForTests()
  })

  it('rejects empty and non-video picks before probing', async () => {
    await expect(probeDeviceClip(new File([], 'empty.mp4', { type: 'video/mp4' }))).rejects.toThrow(
      /empty/i,
    )
    await expect(
      probeDeviceClip(new File(['not-video'], 'photo.jpg', { type: 'image/jpeg' })),
    ).rejects.toThrow(/video/i)
  })

  it('collects per-file failures without aborting the batch', async () => {
    const project = await createProject('Import batch')
    let ensureCalls = 0
    const result = await importDeviceClips(
      [
        new File([], 'empty.mp4', { type: 'video/mp4' }),
        new File(['x'], 'notes.txt', { type: 'text/plain' }),
      ],
      {
        ensureProjectId: async () => {
          ensureCalls += 1
          return project.id
        },
      },
    )
    expect(result.added).toHaveLength(0)
    expect(result.failed).toHaveLength(2)
    expect(result.failed[0]?.name).toBe('empty.mp4')
    expect(result.failed[1]?.name).toBe('notes.txt')
    expect(ensureCalls).toBe(0)
    expect(await getClipsForProject(project.id)).toHaveLength(0)
  })
})
