import { describe, expect, it } from 'vitest'
import type { ClipRecord } from '../types'
import {
  KODY_VIDEO_ENCODER,
  KODY_VIDEO_SITE,
  buildExportDescriptiveMetadata,
  formatChapterTitle,
  formatClipMix,
  formatMetadataDuration,
  locationForExport,
} from './mp4-export-metadata'

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

  it('omits the calendar date from chapter titles when location is off', () => {
    const clip = locatedClip()
    const publicTitle = formatChapterTitle(clip, true, false)
    const privateTitle = formatChapterTitle(clip, true, true)

    expect(publicTitle).toMatch(/\d/)
    expect(publicTitle).not.toContain(clip.lat!.toFixed(4))
    expect(privateTitle.length).toBeGreaterThan(publicTitle.length)
    expect(privateTitle).toContain(clip.lat!.toFixed(4))
  })

  it('omits malformed non-finite coordinates from opted-in chapter titles', () => {
    const clip = locatedClip()

    expect(formatChapterTitle({ ...clip, lat: Number.NaN }, false, true)).not.toContain('NaN')
    expect(
      formatChapterTitle({ ...clip, lng: Number.POSITIVE_INFINITY }, false, true),
    ).not.toContain('Infinity')
  })
})

describe('MP4 export descriptive metadata', () => {
  const video = {
    createdAt: new Date(2026, 7, 8, 14, 30).getTime() + 4_000,
    durationMs: 4_000,
    kind: 'video' as const,
  }
  const photo = {
    createdAt: new Date(2026, 7, 8, 15, 0).getTime() + 3_000,
    durationMs: 3_000,
    kind: 'image' as const,
  }

  it('credits kody.video and summarizes clips without capture-context by default', () => {
    const tags = buildExportDescriptiveMetadata({
      projectName: 'Beach day',
      clips: [video, video, photo],
      filmDurationMs: 24_400,
      hasMusic: true,
      includeLocation: false,
    })

    expect(tags.title).toBe('Beach day')
    expect(tags.encoder).toBe(KODY_VIDEO_ENCODER)
    expect(tags.encoder).toContain(KODY_VIDEO_SITE)
    expect(tags.comment).toBe('3 clips (2 videos, 1 photo) · 24s · with music · kody.video')
    expect(tags.description).toBe(
      ['3 clips (2 videos, 1 photo) · 24s · with music', `Made with Kody Video — ${KODY_VIDEO_SITE}`].join(
        '\n',
      ),
    )
    expect(tags.date).toBeUndefined()
    expect(tags.comment).not.toMatch(/20\d\d/)
    expect(tags.description).not.toMatch(/Filmed/)
    expect(`${tags.title}\n${tags.comment}\n${tags.description}`).not.toContain('40.4179')
  })

  it('adds a filming date only when location metadata is opted in', () => {
    const laterDay = {
      ...video,
      createdAt: new Date(2026, 7, 9, 9, 0).getTime() + 2_000,
      durationMs: 2_000,
    }
    const tags = buildExportDescriptiveMetadata({
      projectName: 'Road trip',
      clips: [video, laterDay],
      filmDurationMs: 6_000,
      hasMusic: false,
      includeLocation: true,
    })

    expect(tags.date).toBe('2026-08-08')
    expect(tags.description).toContain('Filmed 2026-08-08 – 2026-08-09')
    expect(tags.comment).toBe('2 clips · 6s · kody.video')
    expect(tags.comment).not.toContain('2026-08-08')
  })

  it('falls back to a generic title and never treats empty names as identifying', () => {
    const tags = buildExportDescriptiveMetadata({
      projectName: '   ',
      clips: [photo],
      filmDurationMs: 3_000,
      hasMusic: false,
      includeLocation: false,
    })
    expect(tags.title).toBe('Kody Video')
    expect(tags.comment).toBe('1 photo · 3s · kody.video')
  })

  it('formats clip mixes and compact durations', () => {
    expect(formatClipMix([{ kind: 'video' }])).toBe('1 clip')
    expect(formatClipMix([{ kind: 'image' }, { kind: 'image' }])).toBe('2 photos')
    expect(formatClipMix([{ kind: 'video' }, { kind: 'image' }])).toBe(
      '2 clips (1 video, 1 photo)',
    )
    expect(formatMetadataDuration(500)).toBe('1s')
    expect(formatMetadataDuration(65_000)).toBe('1:05')
    expect(formatMetadataDuration(3_661_000)).toBe('1:01:01')
  })
})
