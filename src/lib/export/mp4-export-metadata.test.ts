import { describe, expect, it } from 'vitest'
import type { ClipRecord } from '../types'
import { formatChapterTitle, locationForExport } from './mp4-export-metadata'

function locatedClip(): Pick<ClipRecord, 'createdAt' | 'durationMs' | 'lat' | 'lng'> {
  return {
    createdAt: new Date(2026, 7, 8, 14, 30).getTime() + 2_000,
    durationMs: 2_000,
    lat: 40.41791,
    lng: -111.81496,
  }
}

describe('MP4 export location metadata', () => {
  it('keeps chapter times while omitting coordinates by default', () => {
    const clip = locatedClip()
    const title = formatChapterTitle(clip, false, false)

    expect(title).toMatch(/\d/)
    expect(title).not.toContain(clip.lat!.toFixed(4))
    expect(title).not.toContain(clip.lng!.toFixed(4))
    expect(locationForExport([clip], false)).toBeNull()
  })

  it('includes chapter coordinates and a project geotag when opted in', () => {
    const clip = locatedClip()
    const title = formatChapterTitle(clip, false, true)

    expect(title).toContain(`${clip.lat!.toFixed(4)},${clip.lng!.toFixed(4)}`)
    expect(locationForExport([clip], true)).toEqual({
      lat: clip.lat,
      lng: clip.lng,
    })
  })
})
