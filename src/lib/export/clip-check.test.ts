import { describe, expect, it } from 'vitest'
import audioOnlyMp4Url from '../../../tests/fixtures/audio-only.mp4?url'
import { makeTestClipBlob } from '../testing/make-test-clip'
import type { ClipId, ClipRecord } from '../types'
import {
  deleteUnexportableClipsLabel,
  findUnexportableClips,
  UnexportableClipsError,
  unexportableClipsMessage,
} from './clip-check'
import { exportProject } from './index'

let nextId = 0
function clip(blob: Blob, extra: Partial<ClipRecord> = {}): ClipRecord {
  nextId += 1
  return {
    id: `clip-check-${nextId}` as ClipId,
    projectId: 'project-clip-check',
    blob,
    mimeType: blob.type || 'video/webm',
    durationMs: 1000,
    trimStartMs: 0,
    trimEndMs: 1000,
    width: 320,
    height: 568,
    createdAt: Date.now(),
    ...extra,
  } as ClipRecord
}

async function audioOnly(): Promise<Blob> {
  const bytes = await (await fetch(audioOnlyMp4Url)).arrayBuffer()
  return new Blob([bytes], { type: 'video/mp4;codecs=avc1.640028,mp4a.40.2' })
}

describe('export clip check', () => {
  it('probes every clip and reports each broken one by position', async () => {
    const good = await makeTestClipBlob(400)
    const clips = [clip(good), clip(await audioOnly()), clip(good), clip(await audioOnly())]
    const found = await findUnexportableClips(clips)
    expect(found).toEqual([
      { clipId: clips[1]!.id, position: 2, problem: 'no-video-track' },
      { clipId: clips[3]!.id, position: 4, problem: 'no-video-track' },
    ])
  })

  it('skips photo clips', async () => {
    const photo = clip(new Blob([new Uint8Array(16)], { type: 'image/jpeg' }), { kind: 'image' })
    expect(await findUnexportableClips([photo])).toEqual([])
  })

  it('exportProject fails before encoding, naming every broken clip', async () => {
    const good = await makeTestClipBlob(400)
    const clips = [clip(good), clip(await audioOnly()), clip(await audioOnly())]
    const error = await exportProject(clips, { watermark: false }).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(UnexportableClipsError)
    const broken = error as UnexportableClipsError
    expect(broken.clips.map((item) => item.position)).toEqual([2, 3])
    expect(broken.message).toBe("Clips 2 and 3 have no video and can't be exported.")
  })

  it('words the error and the delete action without em dashes', () => {
    expect(unexportableClipsMessage([2])).toBe("Clip 2 has no video and can't be exported.")
    expect(unexportableClipsMessage([1, 2, 4])).toBe(
      "Clips 1, 2, and 4 have no video and can't be exported.",
    )
    expect(deleteUnexportableClipsLabel([2])).toBe('Delete clip 2 and export')
    expect(deleteUnexportableClipsLabel([2, 3])).toBe('Delete 2 clips and export')
    const copy = [unexportableClipsMessage([1, 2]), deleteUnexportableClipsLabel([1, 2])].join(' ')
    expect(copy).not.toMatch(/\u2014/)
  })
})
