import { describe, expect, it } from 'vitest'
import { blobForPlayback } from './shared'

describe('blobForPlayback', () => {
  it('returns the same blob when mime matches or is omitted', () => {
    const blob = new Blob(['clip'], { type: 'video/mp4' })
    expect(blobForPlayback(blob)).toBe(blob)
    expect(blobForPlayback(blob, 'video/mp4')).toBe(blob)
    expect(blobForPlayback(blob, '  video/mp4  ')).toBe(blob)
  })

  it('retypes octet-stream and empty-type blobs with the clip mime', () => {
    const generic = new Blob(['clip'], { type: 'application/octet-stream' })
    const retyped = blobForPlayback(generic, 'video/mp4')
    expect(retyped).not.toBe(generic)
    expect(retyped.type).toBe('video/mp4')

    const empty = new Blob(['clip'])
    expect(blobForPlayback(empty, 'video/mp4').type).toBe('video/mp4')
  })

  it('prefers the clip mime when the blob type disagrees', () => {
    const mistyped = new Blob(['clip'], { type: 'video/webm' })
    const fixed = blobForPlayback(mistyped, 'video/mp4')
    expect(fixed.type).toBe('video/mp4')
  })
})
