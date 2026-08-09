import { describe, expect, it } from 'vitest'
import type { ClipRecord } from '../types'
import { MIN_SEGMENT_MS, clampSegmentToMedia, planExport } from './plan'

function clip(overrides: Partial<ClipRecord>): ClipRecord {
  return {
    id: overrides.id ?? 'clip_test',
    projectId: 'proj_test',
    blob: new Blob(['x'], { type: 'video/webm' }),
    mimeType: 'video/webm',
    durationMs: 2000,
    trimStartMs: 0,
    trimEndMs: 2000,
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('planExport', () => {
  it('lays segments end to end on the output timeline', () => {
    const plan = planExport([
      clip({ id: 'a', durationMs: 2000, trimEndMs: 2000 }),
      clip({ id: 'b', durationMs: 3000, trimStartMs: 500, trimEndMs: 2500 }),
    ])
    expect(plan.segments).toHaveLength(2)
    expect(plan.segments[0]).toMatchObject({ startMs: 0, endMs: 2000, offsetMs: 0 })
    expect(plan.segments[1]).toMatchObject({ startMs: 500, endMs: 2500, offsetMs: 2000 })
    expect(plan.totalMs).toBe(4000)
  })

  it('clamps trim points that exceed the stored duration', () => {
    const plan = planExport([clip({ durationMs: 1000, trimStartMs: 0, trimEndMs: 5000 })])
    expect(plan.segments[0].endMs).toBe(1000)
    expect(plan.totalMs).toBe(1000)
  })

  it('drops degenerate segments instead of failing', () => {
    const plan = planExport([
      clip({ id: 'tiny', durationMs: 1000, trimStartMs: 990, trimEndMs: 1000 }),
      clip({ id: 'inverted', durationMs: 1000, trimStartMs: 900, trimEndMs: 100 }),
      clip({ id: 'good', durationMs: 1000 }),
    ])
    expect(plan.segments.map((s) => s.clip.id)).toEqual(['good'])
    expect(plan.totalMs).toBe(1000)
  })

  it('plans photo clips as full-duration segments alongside videos', () => {
    const plan = planExport([
      clip({ id: 'video', durationMs: 2000, trimEndMs: 2000 }),
      clip({
        id: 'photo',
        kind: 'image',
        mimeType: 'image/png',
        blob: new Blob(['png'], { type: 'image/png' }),
        durationMs: 7000,
        trimStartMs: 0,
        trimEndMs: 7000,
      }),
    ])
    expect(plan.segments).toHaveLength(2)
    expect(plan.segments[1]).toMatchObject({ startMs: 0, endMs: 7000, offsetMs: 2000 })
    expect(plan.totalMs).toBe(9000)
  })

  it('returns an empty plan for no clips', () => {
    const plan = planExport([])
    expect(plan.segments).toHaveLength(0)
    expect(plan.totalMs).toBe(0)
  })
})

describe('clampSegmentToMedia', () => {
  const segment = {
    clip: clip({ durationMs: 3000 }),
    startMs: 500,
    endMs: 3000,
    offsetMs: 0,
  }

  it('keeps segments within the real media duration', () => {
    expect(clampSegmentToMedia(segment, 2000)).toEqual({ startMs: 500, endMs: 2000 })
  })

  it('passes through when the media duration is unknown', () => {
    expect(clampSegmentToMedia(segment, Number.NaN)).toEqual({ startMs: 500, endMs: 3000 })
  })

  it('rejects segments whose playable range collapses', () => {
    expect(clampSegmentToMedia(segment, 500 + MIN_SEGMENT_MS - 1)).toBeNull()
  })
})
