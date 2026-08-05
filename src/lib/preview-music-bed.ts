import { FADE_IN_MS, FADE_OUT_MS } from './export/background-audio'
import { peekAudioNormalization } from './preview-audio-normalization'
import {
  resolveAudioTrackPlayback,
  type AudioTrackPlayback,
  type ProjectAudioRecord,
  type ProjectAudioTrack,
} from './types'

/**
 * Playlist geometry and per-track gain shared by the two live previews
 * (the project preview overlay and the editor's clip stage). Everything is
 * computed the way the export mixes: tracks contribute their KEPT
 * (trimmed) window clamped to the decoded media, play one after the other
 * from film position 0, carry their own level, and fade in/out where they
 * start/end (interior edges here; the film-edge fades ride each surface's
 * own envelope).
 */

/** A track's playback settings resolved against the playlist defaults. */
export function trackPlayback(
  audio: ProjectAudioRecord,
  track: ProjectAudioTrack,
): AudioTrackPlayback {
  return resolveAudioTrackPlayback(track, audio)
}

/** Track length on the output timeline: the KEPT (trimmed) window, clamped
 * to the real media. The export hands off to the next playlist track where
 * the previous one's DECODED samples end, which can differ from the stored
 * metadata duration — prefer the measured value. */
export function trackKeptDurationMs(audio: ProjectAudioRecord, track: ProjectAudioTrack): number {
  const mediaMs = peekAudioNormalization(track.blob)?.decodedDurationMs ?? track.durationMs
  const playback = trackPlayback(audio, track)
  const endMs = Math.min(playback.trimEndMs, mediaMs)
  return Math.max(0, endMs - Math.min(playback.trimStartMs, endMs))
}

/** Playlist track + in-track KEPT-window offset covering a film position
 * (null when the playlist has already run out there). */
export function playlistTrackAtMs(
  audio: ProjectAudioRecord,
  positionMs: number,
): { index: number; offsetMs: number } | null {
  let cursor = 0
  for (let i = 0; i < audio.tracks.length; i += 1) {
    const keptMs = trackKeptDurationMs(audio, audio.tracks[i])
    if (positionMs < cursor + keptMs) {
      return { index: i, offsetMs: positionMs - cursor }
    }
    cursor += keptMs
  }
  return null
}

/** Film position where track `index`'s kept window ends. */
export function playlistBoundaryMs(audio: ProjectAudioRecord, index: number): number {
  let end = 0
  for (let i = 0; i <= index && i < audio.tracks.length; i += 1) {
    end += trackKeptDurationMs(audio, audio.tracks[i])
  }
  return end
}

/** MEDIA time (seconds) for a kept-window offset — trims shift the start. */
export function trackMediaSec(
  audio: ProjectAudioRecord,
  index: number,
  keptOffsetMs: number,
): number {
  return (trackPlayback(audio, audio.tracks[index]).trimStartMs + keptOffsetMs) / 1000
}

/**
 * The export's per-track music gain at the element's media position: the
 * track's level shaped by its interior fades — fade-in only for tracks
 * starting mid-film (the film-opening fade rides the surface's envelope),
 * fade-out only when the track ends before the film does (a film-end cut
 * fades via the surface's end-of-film scale).
 */
export function trackMusicGain(
  audio: ProjectAudioRecord,
  index: number,
  mediaSec: number,
  filmTotalMs: number,
): number {
  const track = audio.tracks[index]
  if (!track) return 1
  const playback = trackPlayback(audio, track)
  let gain = playback.volume
  const posMs = mediaSec * 1000 - playback.trimStartMs
  if (playback.fadeIn && index > 0 && posMs < FADE_IN_MS) {
    gain *= Math.max(0, posMs / FADE_IN_MS)
  }
  if (playback.fadeOut && playlistBoundaryMs(audio, index) < filmTotalMs) {
    const tailMs = trackKeptDurationMs(audio, track) - posMs
    if (tailMs < FADE_OUT_MS) gain *= Math.max(0, tailMs / FADE_OUT_MS)
  }
  return gain
}

/** The export's end-of-film fade-out scale at a film position: when the
 * track playing at the film's end has fade-out on, the music eases toward
 * silence inside the final FADE_OUT_MS. */
export function playlistFadeOutScale(
  audio: ProjectAudioRecord,
  positionMs: number,
  filmTotalMs: number,
): number {
  if (filmTotalMs <= 0) return 1
  const covering = playlistTrackAtMs(audio, Math.max(0, filmTotalMs - 1))
  if (!covering || !trackPlayback(audio, audio.tracks[covering.index]).fadeOut) return 1
  return Math.max(0, Math.min(1, (filmTotalMs - positionMs) / FADE_OUT_MS))
}

/** The film-opening fade-in scale at a film position (the first track's
 * fade-in) — used by surfaces that can start mid-film (the clip stage);
 * the overlay plays from 0 and glides its envelope up instead. */
export function playlistFadeInScale(audio: ProjectAudioRecord, positionMs: number): number {
  const first = audio.tracks[0]
  if (!first || !trackPlayback(audio, first).fadeIn) return 1
  return Math.max(0, Math.min(1, positionMs / FADE_IN_MS))
}
