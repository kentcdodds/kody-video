import { describe, expect, it } from 'vitest'
import { planClipQualityReduction, scaleToLongEdge } from './clip-quality'
import type { ClipRecord } from './types'

function clip(overrides: Partial<ClipRecord> = {}): ClipRecord {
  return {
    id: 'clip_1',
    projectId: 'proj_1',
    mimeType: 'video/webm',
    durationMs: 10_000,
    trimStartMs: 0,
    trimEndMs: 10_000,
    createdAt: 1,
    blob: new Blob([new Uint8Array(10 * 1024 * 1024)], { type: 'video/webm' }),
    width: 1080,
    height: 1920,
    ...overrides,
  }
}

describe('scaleToLongEdge', () => {
  it('scales 1080×1920 to a 720p long edge and keeps dims even', () => {
    expect(scaleToLongEdge(1080, 1920, 1280)).toEqual({ width: 720, height: 1280 })
    expect(scaleToLongEdge(1920, 1080, 1280)).toEqual({ width: 1280, height: 720 })
  })

  it('does not upscale', () => {
    expect(scaleToLongEdge(720, 1280, 1280)).toEqual({ width: 720, height: 1280 })
  })
})

describe('planClipQualityReduction', () => {
  it('plans 720p for a large 1080p file', () => {
    const plan = planClipQualityReduction(clip())
    expect(plan).not.toBeNull()
    expect(plan?.width).toBe(720)
    expect(plan?.height).toBe(1280)
    expect(plan?.summary).toMatch(/720p/)
    expect(plan?.bitrate).toBeGreaterThan(1_000_000)
  })

  it('plans a smaller bitrate for a fat 720p file', () => {
    const plan = planClipQualityReduction(
      clip({
        width: 720,
        height: 1280,
        blob: new Blob([new Uint8Array(8 * 1024 * 1024)], { type: 'video/webm' }),
      }),
    )
    expect(plan).not.toBeNull()
    expect(plan?.width).toBe(720)
    expect(plan?.height).toBe(1280)
    expect(plan?.summary).toMatch(/smaller bitrate/)
  })

  it('skips photos and already-small files', () => {
    expect(planClipQualityReduction(clip({ kind: 'image' }))).toBeNull()
    expect(
      planClipQualityReduction(
        clip({
          width: 720,
          height: 1280,
          durationMs: 10_000,
          blob: new Blob([new Uint8Array(200_000)], { type: 'video/webm' }),
        }),
      ),
    ).toBeNull()
  })
})
