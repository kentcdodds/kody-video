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
  it('signs portrait projects identically to before the orientation setting', () => {
    const clips = [fakeClip('clip_a')]
    // Cached exports from app versions without the setting must survive the
    // update: absent and explicit-portrait orientations both sign like the
    // old three-argument call.
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
})
