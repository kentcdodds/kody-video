import { describe, expect, it } from 'vitest'
import {
  MIN_SLICE_MS,
  canSplitClip,
  clampSplitMs,
  clipHasUnusedMedia,
  remapTrimToSlice,
  resolveSplitMs,
  splitBounds,
} from './clip-edit'

const video = (trimStartMs: number, trimEndMs: number, durationMs = 2000) => ({
  durationMs,
  trimStartMs,
  trimEndMs,
})

describe('clipHasUnusedMedia', () => {
  it('is false for a fully kept video and for photos', () => {
    expect(clipHasUnusedMedia(video(0, 2000))).toBe(false)
    expect(clipHasUnusedMedia({ ...video(0, 3000, 3000), kind: 'image' })).toBe(false)
  })

  it('is true when a usable range is trimmed', () => {
    expect(clipHasUnusedMedia(video(200, 1600))).toBe(true)
    expect(clipHasUnusedMedia(video(0, 1500))).toBe(true)
  })
})

describe('canSplitClip', () => {
  it('requires a kept window of at least two slices', () => {
    expect(canSplitClip(video(0, MIN_SLICE_MS * 2 - 1))).toBe(false)
    expect(canSplitClip(video(0, MIN_SLICE_MS * 2))).toBe(true)
    expect(canSplitClip({ ...video(0, 2000), kind: 'image' })).toBe(false)
  })
})

describe('splitBounds', () => {
  it('keeps a MIN_SLICE_MS margin inside the kept window', () => {
    expect(splitBounds(video(200, 1800))).toEqual({
      start: 200,
      end: 1800,
      min: 300,
      max: 1700,
    })
  })
})

describe('clampSplitMs', () => {
  it('clamps into the legal cut range', () => {
    expect(clampSplitMs(video(200, 1800), 900)).toBe(900)
    expect(clampSplitMs(video(200, 1800), 200)).toBe(300)
    expect(clampSplitMs(video(200, 1800), 1800)).toBe(1700)
  })

  it('falls back to the midpoint when the value is not finite', () => {
    expect(clampSplitMs(video(200, 1800), Number.NaN)).toBe(1000)
  })
})

describe('resolveSplitMs', () => {
  it('uses the playhead when it sits inside the kept window', () => {
    expect(resolveSplitMs(video(200, 1800), 900)).toBe(900)
  })

  it('falls back to the kept midpoint at the edges or when missing', () => {
    expect(resolveSplitMs(video(200, 1800), 200)).toBe(1000)
    expect(resolveSplitMs(video(200, 1800), null)).toBe(1000)
  })
})

describe('remapTrimToSlice', () => {
  it('keeps the overlapping trim on each half of a split', () => {
    const clip = video(400, 1600, 2000)
    expect(remapTrimToSlice(clip, 0, 1000)).toEqual({ trimStartMs: 400, trimEndMs: 1000 })
    expect(remapTrimToSlice(clip, 1000, 1000)).toEqual({ trimStartMs: 0, trimEndMs: 600 })
  })
})
