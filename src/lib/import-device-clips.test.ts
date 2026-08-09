import { beforeEach, describe, expect, it } from 'vitest'
import {
  importDeviceClips,
  isLikelyImageFile,
  isLikelyVideoFile,
  mimeTypeForDeviceFile,
  mimeTypeForDeviceImage,
  probeDeviceClip,
  probeDeviceImage,
} from './import-device-clips'
import { __resetDbForTests, createProject, getClipsForProject } from './storage'
import { DEFAULT_IMAGE_DURATION_MS } from './types'

/** A real decodable PNG File, drawn in-page (browser-mode tests). */
async function makeTestImageFile(
  name = 'photo.png',
  width = 64,
  height = 48,
): Promise<File> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas not available')
  ctx.fillStyle = '#3aa76d'
  ctx.fillRect(0, 0, width, height)
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/png')
  })
  if (!blob) throw new Error('Could not encode test image')
  return new File([blob], name, { type: 'image/png' })
}

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

describe('isLikelyImageFile / mimeTypeForDeviceImage', () => {
  it('accepts image/* types and image extensions with empty types', () => {
    expect(isLikelyImageFile({ name: 'a.bin', type: 'image/png' })).toBe(true)
    expect(isLikelyImageFile({ name: 'photo.JPG', type: '' })).toBe(true)
    expect(isLikelyImageFile({ name: 'photo.webp', type: 'application/octet-stream' })).toBe(true)
  })

  it('rejects videos and extension-less ambiguous picks (video path decides those)', () => {
    expect(isLikelyImageFile({ name: 'clip.mp4', type: 'video/mp4' })).toBe(false)
    expect(isLikelyImageFile({ name: 'content', type: '' })).toBe(false)
    expect(isLikelyImageFile({ name: 'notes.txt', type: 'text/plain' })).toBe(false)
  })

  it('infers image MIME types from extensions when the type is empty', () => {
    expect(mimeTypeForDeviceImage({ name: 'a.PNG', type: '' })).toBe('image/png')
    expect(mimeTypeForDeviceImage({ name: 'a.webp', type: '' })).toBe('image/webp')
    expect(mimeTypeForDeviceImage({ name: 'a.jpg', type: '' })).toBe('image/jpeg')
    expect(mimeTypeForDeviceImage({ name: 'a.jpeg', type: 'image/jpeg' })).toBe('image/jpeg')
  })
})

describe('probeDeviceClip / importDeviceClips', () => {
  beforeEach(async () => {
    await __resetDbForTests()
  })

  it('rejects empty and unreadable picks before probing', async () => {
    await expect(probeDeviceClip(new File([], 'empty.mp4', { type: 'video/mp4' }))).rejects.toThrow(
      /empty/i,
    )
    // Image-typed picks take the photo path; junk bytes fail its decode.
    await expect(
      probeDeviceClip(new File(['not-an-image'], 'photo.jpg', { type: 'image/jpeg' })),
    ).rejects.toThrow(/photo/i)
    await expect(
      probeDeviceClip(new File(['not-video'], 'notes.txt', { type: 'text/plain' })),
    ).rejects.toThrow(/video or photo/i)
  })

  it('probes a photo pick as an image clip with the default duration', async () => {
    const probed = await probeDeviceImage(await makeTestImageFile('photo.png', 64, 48))
    expect(probed.kind).toBe('image')
    expect(probed.mimeType).toBe('image/png')
    expect(probed.durationMs).toBe(DEFAULT_IMAGE_DURATION_MS)
    expect(probed.width).toBe(64)
    expect(probed.height).toBe(48)
  })

  it('imports photos into the timeline as image clips', async () => {
    const project = await createProject('Photo import')
    const result = await importDeviceClips([await makeTestImageFile()], {
      ensureProjectId: async () => project.id,
    })
    expect(result.failed).toHaveLength(0)
    expect(result.added).toHaveLength(1)
    const clips = await getClipsForProject(project.id)
    expect(clips).toHaveLength(1)
    expect(clips[0]!.kind).toBe('image')
    expect(clips[0]!.durationMs).toBe(DEFAULT_IMAGE_DURATION_MS)
    expect(clips[0]!.trimStartMs).toBe(0)
    expect(clips[0]!.trimEndMs).toBe(DEFAULT_IMAGE_DURATION_MS)
    // Photos are silent by construction — the zero peak is persisted so the
    // loader backfill never attempts an audio decode on image bytes.
    expect(clips[0]!.audioPeak).toBe(0)
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
