import { describe, expect, it } from 'vitest'
import audioOnlyMp4Url from '../../tests/fixtures/audio-only.mp4?url'
import { findClipVideoProblem } from './clip-video-check'
import { makeTestClipBlob } from './testing/make-test-clip'

async function audioOnlyMp4(): Promise<Blob> {
  const bytes = await (await fetch(audioOnlyMp4Url)).arrayBuffer()
  return new Blob([bytes], { type: 'video/mp4;codecs=avc1.640028,mp4a.40.2' })
}

describe('findClipVideoProblem', () => {
  it('flags an audio-only fragmented MP4 (the broken take shape)', async () => {
    expect(await findClipVideoProblem(await audioOnlyMp4())).toBe('no-video-track')
  })

  it('accepts a clip with video frames', async () => {
    expect(await findClipVideoProblem(await makeTestClipBlob(500))).toBeNull()
  })

  it('flags an empty file', async () => {
    expect(await findClipVideoProblem(new Blob([], { type: 'video/mp4' }))).toBe('no-video-track')
  })

  it('does not condemn bytes it cannot parse', async () => {
    const junk = new Blob([new Uint8Array(4096).fill(7)], { type: 'video/mp4' })
    expect(await findClipVideoProblem(junk)).toBeNull()
  })
})
