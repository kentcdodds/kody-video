import { describe, expect, it } from 'vitest'
import type { ClipRecord } from '../types'
import { exportSignature } from './last-export'

function fakeClip(id: string): ClipRecord {
  return {
    id,
    projectId: 'proj_x',
    blob: new Blob(['clip'], { type: 'video/mp4' }),
    mimeType: 'video/mp4',
    durationMs: 1500,
    trimStartMs: 0,
    trimEndMs: 1500,
    createdAt: 1700000000000,
  }
}

describe('exportSignature', () => {
  it('signs absent and portrait orientations identically', () => {
    const clips = [fakeClip('clip_a')]
    expect(exportSignature(clips, true, null, 'portrait')).toBe(
      exportSignature(clips, true, null),
    )
    expect(exportSignature(clips, true, null, undefined)).toBe(
      exportSignature(clips, true, null),
    )
  })

  it('signs landscape differently so the cached export re-renders', () => {
    const clips = [fakeClip('clip_a')]
    expect(exportSignature(clips, true, null, 'landscape')).not.toBe(
      exportSignature(clips, true, null, 'portrait'),
    )
  })

  it('signs location inclusion differently so a cached geotag is never reused', () => {
    const clips = [fakeClip('clip_a')]
    expect(exportSignature(clips, false, null, 'portrait', true)).not.toBe(
      exportSignature(clips, false, null, 'portrait', false),
    )
  })

  it('signs the project title so a rename cannot reuse the old file metadata', () => {
    const clips = [fakeClip('clip_a')]
    expect(exportSignature(clips, false, null, 'portrait', false, 'Beach day')).not.toBe(
      exportSignature(clips, false, null, 'portrait', false, 'Road trip'),
    )
  })

  it('signs letterbox so a fit change cannot reuse a cropped export', () => {
    const cropped = [fakeClip('clip_a')]
    const letterboxed = [{ ...fakeClip('clip_a'), fit: 'letterbox' as const }]
    expect(exportSignature(letterboxed, false, null, 'portrait')).not.toBe(
      exportSignature(cropped, false, null, 'portrait'),
    )
  })
})
