import { describe, expect, it } from 'vitest'
import {
  buildClipFacts,
  clipDownloadFilename,
  formatClipAspect,
  formatClipBytes,
  formatClipMime,
  formatLatLng,
} from './clip-facts'
import type { ClipRecord } from './types'

function clip(overrides: Partial<ClipRecord> = {}): ClipRecord {
  return {
    id: 'clip_1',
    projectId: 'proj_1',
    mimeType: 'video/webm',
    durationMs: 2000,
    trimStartMs: 0,
    trimEndMs: 2000,
    createdAt: Date.UTC(2026, 7, 15, 12, 0, 0),
    blob: new Blob(['x'.repeat(1500)], { type: 'video/webm' }),
    width: 320,
    height: 568,
    ...overrides,
  }
}

describe('clip fact formatters', () => {
  it('formats bytes, mime, aspect, and coordinates', () => {
    expect(formatClipBytes(800)).toBe('800 B')
    expect(formatClipBytes(12_500)).toBe('12 KB')
    expect(formatClipBytes(2.4 * 1024 * 1024)).toBe('2.4 MB')
    expect(formatClipMime('video/webm;codecs=vp8')).toBe('WebM')
    expect(formatClipMime('image/jpeg')).toBe('JPEG')
    expect(formatClipAspect(1080, 1920)).toBe('9:16')
    expect(formatLatLng(40.7, -74)).toBe('40.7000° N, 74.0000° W')
  })

  it('names a downloaded clip from the project and mime', () => {
    expect(clipDownloadFilename('Ski Trip', 0, 'video/mp4')).toBe('ski-trip-clip-01.mp4')
    expect(clipDownloadFilename('Ski Trip', 1, 'video/quicktime')).toBe('ski-trip-clip-02.mp4')
    expect(clipDownloadFilename('Ski Trip', 3, 'image/png')).toBe('ski-trip-clip-04.png')
  })
})

describe('buildClipFacts', () => {
  it('includes place in the film, size, and unused media when trimmed', () => {
    const facts = buildClipFacts(clip({ trimStartMs: 400, trimEndMs: 1400, lat: 10, lng: 20 }), {
      index: 1,
      clipCount: 4,
      filmDurationMs: 4000,
    })
    const byLabel = Object.fromEntries(facts.map((fact) => [fact.label, fact.value]))
    expect(byLabel.Clip).toBe('2 of 4')
    expect(byLabel.Kept).toMatch(/1\.0s of 2\.0s/)
    expect(byLabel.Unused).toMatch(/1\.0s/)
    expect(byLabel.Size).toMatch(/320 × 568/)
    expect(byLabel.File).toMatch(/WebM/)
    expect(byLabel.Location).toMatch(/10\.0000° N/)
    expect(byLabel['Of the film']).toBe('25%')
  })

  it('labels a photo and skips unused-media rows', () => {
    const facts = buildClipFacts(clip({ kind: 'image', mimeType: 'image/jpeg' }), {
      index: 0,
      clipCount: 1,
      filmDurationMs: 3000,
    })
    const labels = facts.map((fact) => fact.label)
    expect(labels).toContain('Photo')
    expect(labels).toContain('On screen')
    expect(labels).not.toContain('Unused')
  })
})
