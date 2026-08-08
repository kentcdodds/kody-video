import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TRACK_VOLUME,
  audioTrackKeptMs,
  audioTrackLevel,
  clipMusicVolume,
  clipSoundVolume,
  effectiveDurationMs,
  formatDuration,
  projectAudioTotalDurationMs,
  projectOrientation,
  resolveAudioTrackPlayback,
} from './types'

describe('duration helpers', () => {
  it('computes effective duration from trim points', () => {
    expect(
      effectiveDurationMs({
        durationMs: 5000,
        trimStartMs: 1000,
        trimEndMs: 3500,
      }),
    ).toBe(2500)
  })

  it('formats short and long durations', () => {
    expect(formatDuration(1500)).toBe('1.5s')
    expect(formatDuration(61500)).toBe('1:01.5')
  })
})

describe('project orientation', () => {
  it('defaults to portrait for projects without the field (older records)', () => {
    expect(projectOrientation({})).toBe('portrait')
    expect(projectOrientation({ orientation: undefined })).toBe('portrait')
  })

  it('reads an explicit orientation', () => {
    expect(projectOrientation({ orientation: 'landscape' })).toBe('landscape')
    expect(projectOrientation({ orientation: 'portrait' })).toBe('portrait')
  })
})

describe('audio track playback helpers', () => {
  const playlist = { fadeIn: true, fadeOut: false }

  it('defaults to the whole track at the default volume with playlist fades', () => {
    const playback = resolveAudioTrackPlayback({ durationMs: 30_000 }, playlist)
    expect(playback).toEqual({
      trimStartMs: 0,
      trimEndMs: 30_000,
      keptMs: 30_000,
      volume: DEFAULT_TRACK_VOLUME,
      fadeIn: true,
      fadeOut: false,
    })
  })

  it('resolves explicit trim, level, and fades', () => {
    const playback = resolveAudioTrackPlayback(
      {
        durationMs: 30_000,
        trimStartMs: 5_000,
        trimEndMs: 12_000,
        volume: 0.6,
        fadeIn: false,
        fadeOut: true,
      },
      playlist,
    )
    expect(playback).toEqual({
      trimStartMs: 5_000,
      trimEndMs: 12_000,
      keptMs: 7_000,
      volume: 0.6,
      fadeIn: false,
      fadeOut: true,
    })
  })

  it('clamps trim points into the media and against each other', () => {
    const playback = resolveAudioTrackPlayback(
      { durationMs: 10_000, trimStartMs: 9_000, trimEndMs: 40_000 },
      playlist,
    )
    expect(playback.trimEndMs).toBe(10_000)
    expect(playback.keptMs).toBe(1_000)
    // A start past the end collapses to an empty window, never negative.
    expect(
      resolveAudioTrackPlayback(
        { durationMs: 10_000, trimStartMs: 8_000, trimEndMs: 4_000 },
        playlist,
      ).keptMs,
    ).toBe(0)
  })

  it('keeps an unknown track length open-ended', () => {
    const playback = resolveAudioTrackPlayback({ trimStartMs: 2_000 }, playlist)
    expect(playback.trimStartMs).toBe(2_000)
    expect(playback.trimEndMs).toBe(Infinity)
  })

  it('clamps the volume and treats junk as the default', () => {
    expect(audioTrackLevel({})).toBe(DEFAULT_TRACK_VOLUME)
    expect(audioTrackLevel({ volume: 0.4 })).toBe(0.4)
    expect(audioTrackLevel({ volume: 3 })).toBe(1)
    expect(audioTrackLevel({ volume: -1 })).toBe(0)
    expect(audioTrackLevel({ volume: Number.NaN })).toBe(DEFAULT_TRACK_VOLUME)
  })

  it('defaults both per-clip levels to full volume and clamps them', () => {
    expect(clipSoundVolume({})).toBe(1)
    expect(clipSoundVolume({ clipVolume: 0.3 })).toBe(0.3)
    expect(clipSoundVolume({ clipVolume: 5 })).toBe(1)
    expect(clipSoundVolume({ clipVolume: Number.NaN })).toBe(1)
    expect(clipMusicVolume({})).toBe(1)
    expect(clipMusicVolume({ musicVolume: 0.7 })).toBe(0.7)
    expect(clipMusicVolume({ musicVolume: -2 })).toBe(0)
  })

  it('sums kept (trimmed) lengths for the playlist coverage', () => {
    expect(audioTrackKeptMs({ durationMs: 8_000, trimStartMs: 1_000, trimEndMs: 5_000 })).toBe(
      4_000,
    )
    expect(
      projectAudioTotalDurationMs({
        tracks: [
          { durationMs: 8_000, trimStartMs: 1_000, trimEndMs: 5_000 },
          { durationMs: 6_000 },
        ] as never,
      }),
    ).toBe(10_000)
  })
})
