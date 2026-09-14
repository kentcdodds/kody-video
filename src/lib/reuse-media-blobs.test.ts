import { describe, expect, it } from 'vitest'
import { reuseAudioMediaBlobs, reuseClipMediaBlobs, sameMediaBlob } from './reuse-media-blobs'
import type { ClipRecord, ProjectAudioRecord } from './types'

function clip(id: string, blob: Blob): ClipRecord {
  return {
    id,
    projectId: 'proj',
    mimeType: blob.type || 'video/webm',
    durationMs: 2000,
    trimStartMs: 0,
    trimEndMs: 2000,
    createdAt: 1,
    blob,
  }
}

describe('sameMediaBlob', () => {
  it('treats identical wrappers or equal size+type as the same media', () => {
    const blob = new Blob(['clip'], { type: 'video/webm' })
    expect(sameMediaBlob(blob, blob)).toBe(true)
    expect(sameMediaBlob(blob, new Blob(['clip'], { type: 'video/webm' }))).toBe(true)
    expect(sameMediaBlob(blob, new Blob(['clip!'], { type: 'video/webm' }))).toBe(false)
    expect(sameMediaBlob(blob, new Blob(['clip'], { type: 'video/mp4' }))).toBe(false)
  })
})

describe('reuseClipMediaBlobs', () => {
  it('keeps the previous blob object when a reload wraps the same bytes', () => {
    const live = new Blob(['same-bytes'], { type: 'video/webm' })
    const reloaded = new Blob(['same-bytes'], { type: 'video/webm' })
    const [next] = reuseClipMediaBlobs([clip('a', live)], [clip('a', reloaded)])
    expect(next?.blob).toBe(live)
  })

  it('adopts a replacement blob when the media itself changed', () => {
    const live = new Blob(['old'], { type: 'video/webm' })
    const smaller = new Blob(['replacement-media'], { type: 'video/webm' })
    const [next] = reuseClipMediaBlobs([clip('a', live)], [clip('a', smaller)])
    expect(next?.blob).toBe(smaller)
  })

  it('keeps refreshed thumbs while holding the live media blob', () => {
    const live = new Blob(['same-bytes'], { type: 'video/webm' })
    const previous = { ...clip('a', live), thumbs: [new Blob(['old-thumb'])] }
    const reloaded = {
      ...clip('a', new Blob(['same-bytes'], { type: 'video/webm' })),
      thumbs: [new Blob(['new-thumb']), new Blob(['new-thumb-2'])],
    }
    const [next] = reuseClipMediaBlobs([previous], [reloaded])
    expect(next?.blob).toBe(live)
    expect(next?.thumbs).toHaveLength(2)
  })
})

describe('reuseAudioMediaBlobs', () => {
  it('keeps track blob objects across playlist reloads', () => {
    const live = new Blob(['song'], { type: 'audio/wav' })
    const previous: ProjectAudioRecord = {
      projectId: 'proj',
      fadeIn: true,
      fadeOut: true,
      tracks: [
        {
          id: 't1',
          blob: live,
          mimeType: 'audio/wav',
          durationMs: 8000,
          name: 'song.wav',
          addedAt: 1,
        },
      ],
    }
    const reloaded: ProjectAudioRecord = {
      ...previous,
      tracks: [{ ...previous.tracks[0]!, blob: new Blob(['song'], { type: 'audio/wav' }) }],
    }
    const next = reuseAudioMediaBlobs(previous, reloaded)
    expect(next?.tracks[0]?.blob).toBe(live)
  })
})
