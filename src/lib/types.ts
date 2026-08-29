export type ProjectId = string
export type ClipId = string

/** The film's shape: portrait (the default, phone-style) or landscape.
 * Landscape is a Kody Video Plus perk. Defaults to the first clip's
 * orientation; the user can change it later as a project setting. */
export type ProjectOrientation = 'portrait' | 'landscape'

/** How a mismatched clip is fitted into the film. Absent = crop. */
export type ClipFit = 'crop' | 'letterbox'

export interface Project {
  id: ProjectId
  name: string
  createdAt: number
  updatedAt: number
  clipIds: ClipId[]
  /** True while the name is still the generated "Project N" — cleared on
   * rename, and never set for caller-chosen names, so a deliberate name
   * (even one shaped like "Project 2") is never mistaken for the default. */
  nameIsDefault?: boolean
  /** The film's export orientation. Absent = portrait. The first clip
   * sets this when the project is still empty; the user can change it. */
  orientation?: ProjectOrientation
}

/** A project's orientation, defaulting portrait for records without one. */
export function projectOrientation(
  project: Pick<Project, 'orientation'>,
): ProjectOrientation {
  return project.orientation === 'landscape' ? 'landscape' : 'portrait'
}

/** What a timeline clip is made of. Absent = 'video' (every clip recorded
 * or imported before photos existed stores nothing). */
export type ClipKind = 'video' | 'image'

export interface ClipMeta {
  id: ClipId
  projectId: ProjectId
  /** 'image' for a still photo shown for `durationMs`; absent = video. */
  kind?: ClipKind
  mimeType: string
  durationMs: number
  trimStartMs: number
  trimEndMs: number
  createdAt: number
  width?: number
  height?: number
  /** Fit into a mismatched film. Absent = crop (the default). */
  fit?: ClipFit
  thumbWidth?: number
  thumbHeight?: number
  /** Opt-in geolocation captured at recording time (absent on older clips
   * and whenever tagging is off or unavailable). */
  lat?: number
  lng?: number
  locationAccuracyM?: number
  /** This clip's own (foreground) sound level (0–1). Absent = full. */
  clipVolume?: number
  /** Background-music level (0–1) while this clip plays, scaling the
   * playing track's own volume (duck the music under speech). Absent =
   * full (the track's volume alone). */
  musicVolume?: number
  /** Measured whole-clip audio peak (0–1) at the export's mixing rate —
   * the persisted normalization measurement (0 = silent or undecodable).
   * Absent = not yet measured; backfilled automatically on project load. */
  audioPeak?: number
}

export interface ClipRecord extends ClipMeta {
  blob: Blob
  /** Filmstrip poster frames (JPEG). Generated lazily for old clips. */
  thumbs?: Blob[]
  /** High-resolution poster frame for the home slot art. */
  poster?: Blob
}

export interface DeletedClipSnapshot {
  clip: ClipRecord
  index: number
  deletedAt: number
}

/** One entry in a project's background-music playlist. */
export interface ProjectAudioTrack {
  id: string
  blob: Blob
  mimeType: string
  durationMs: number
  /** Display name (the picked file's name). */
  name: string
  addedAt: number
  /** Kept range of the track (defaults to the whole file). Only this
   * window plays; the next track starts where it ends. */
  trimStartMs?: number
  trimEndMs?: number
  /** Track volume (0–1): the music's level under the clips while this
   * track plays (clips can duck it further via their own musicVolume).
   * Absent = DEFAULT_TRACK_VOLUME. */
  volume?: number
  /** Ease this track in/out where it starts/ends. Absent = inherit the
   * playlist's fade flags (kept for records made before per-track fades). */
  fadeIn?: boolean
  fadeOut?: boolean
}

/**
 * A project's background music: tracks play one after the other under the
 * clips until the film ends (the last one is cut off there — nothing
 * loops), each at its own volume, which clips can duck individually.
 */
export interface ProjectAudioRecord {
  projectId: ProjectId
  tracks: ProjectAudioTrack[]
  /** Playlist-level fade defaults, inherited by tracks without their own
   * fadeIn/fadeOut flags (records made before per-track fades). */
  fadeIn: boolean
  fadeOut: boolean
}

/** Default track volume: music at 25% sits under speech without drowning
 * it (both sides are peak-normalized, so 100% would rival the clips). */
export const DEFAULT_TRACK_VOLUME = 0.25

/** The fields that shape how one playlist track plays back. `durationMs`
 * is optional so export-side track shapes (which may not know it) fit. */
export interface AudioTrackPlaybackFields {
  durationMs?: number
  trimStartMs?: number
  trimEndMs?: number
  volume?: number
  fadeIn?: boolean
  fadeOut?: boolean
}

export interface AudioTrackPlayback {
  trimStartMs: number
  /** Infinity when the track length is unknown (export shapes without
   * durationMs and no explicit trim end). */
  trimEndMs: number
  keptMs: number
  volume: number
  fadeIn: boolean
  fadeOut: boolean
}

/** Resolve a track's playback settings against its playlist's defaults:
 * trim clamped into the media, volume defaulting to DEFAULT_TRACK_VOLUME,
 * fades falling back to the playlist flags. */
export function resolveAudioTrackPlayback(
  track: AudioTrackPlaybackFields,
  playlist: { fadeIn: boolean; fadeOut: boolean },
): AudioTrackPlayback {
  const durationMs = track.durationMs ?? Infinity
  const trimEndMs = Math.max(0, Math.min(track.trimEndMs ?? durationMs, durationMs))
  const trimStartMs = Math.max(0, Math.min(track.trimStartMs ?? 0, trimEndMs))
  return {
    trimStartMs,
    trimEndMs,
    keptMs: Math.max(0, trimEndMs - trimStartMs),
    volume: audioTrackLevel(track),
    fadeIn: track.fadeIn ?? playlist.fadeIn,
    fadeOut: track.fadeOut ?? playlist.fadeOut,
  }
}

/** The track's kept (trimmed) length. */
export function audioTrackKeptMs(
  track: Pick<ProjectAudioTrack, 'durationMs' | 'trimStartMs' | 'trimEndMs'>,
): number {
  const end = Math.max(0, Math.min(track.trimEndMs ?? track.durationMs, track.durationMs))
  const start = Math.max(0, Math.min(track.trimStartMs ?? 0, end))
  return Math.max(0, end - start)
}

/** The track's volume (0–1) — the music's level under the clips while it
 * plays; default DEFAULT_TRACK_VOLUME. */
export function audioTrackLevel(track: Pick<AudioTrackPlaybackFields, 'volume'>): number {
  if (track.volume === undefined || !Number.isFinite(track.volume)) return DEFAULT_TRACK_VOLUME
  return Math.max(0, Math.min(1, track.volume))
}

/** Total playlist length — what the music can cover before going silent. */
export function projectAudioTotalDurationMs(audio: Pick<ProjectAudioRecord, 'tracks'>): number {
  return audio.tracks.reduce((sum, track) => sum + audioTrackKeptMs(track), 0)
}

export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 1
  return Math.max(0, Math.min(1, volume))
}

/** The clip's own (foreground) sound level (0–1); default full. */
export function clipSoundVolume(clip: Pick<ClipMeta, 'clipVolume'>): number {
  return clampVolume(clip.clipVolume ?? 1)
}

/** The music's level (0–1) while this clip plays, scaling the playing
 * track's own volume; default full (no duck). */
export function clipMusicVolume(clip: Pick<ClipMeta, 'musicVolume'>): number {
  return clampVolume(clip.musicVolume ?? 1)
}

export interface AppMeta {
  key: 'settings'
  maxProjects: number
  lastOpenedProjectId: ProjectId | null
  onboardingDismissed: boolean
  /** Home-page "Watch the tour" card dismissed (first-timer teaser). */
  tourCardDismissed?: boolean
  /** One-time Kody Video Plus purchase (verified via Stripe). */
  watermarkRemoved?: boolean
  purchaseSessionId?: string | null
  /**
   * Plus opt-in: keep stamping the Kody mark on exports even after purchase.
   * Default off — Plus removes the watermark unless the user chooses this.
   */
  keepWatermark?: boolean
  /**
   * Plus opt-in: include captured clip coordinates in MP4 metadata and
   * chapter titles, and filming dates in the file description. Default off
   * so a public share cannot disclose location or when it was filmed.
   */
  includeLocationInExports?: boolean
  /** Opt-in: tag new clips with device location. */
  locationTaggingEnabled?: boolean
  /**
   * Capture size/bitrate for new recordings. Missing/unknown = high (1080p).
   * Does not rewrite already-saved clips. Frame rate stays 30 either way.
   */
  videoQuality?: 'high' | 'standard' | 'saver'
  /** The persisted last export (OPFS-backed), recoverable after the share
   * sheet is missed — and served instantly when nothing changed. */
  lastExport?: {
    projectId: ProjectId
    opfsName: string
    mimeType: string
    fileExtension: 'mp4' | 'webm'
    createdAt: number
    /** Fingerprint of clips, render settings, and export metadata choices
     * that produced the file — any difference means a fresh export is needed. */
    signature: string
    watermarked: boolean
    /** Whether the cached file actually contains clip-location metadata. */
    locationIncluded?: boolean
  } | null
}

export const MAX_PROJECTS = 6

/** Projects included without the Kody Video Plus purchase. */
export const FREE_PROJECTS = 1

/** Route id for a project that exists only as a URL until the first clip is
 * recorded — backing out of an empty "new project" leaves nothing behind. */
export const NEW_PROJECT_ID: ProjectId = 'new'

/** True when the clip is a still photo shown for its duration. */
export function isImageClip(clip: Pick<ClipMeta, 'kind'>): boolean {
  return clip.kind === 'image'
}

/** How long a photo shows by default — long enough to read, short enough
 * to keep the film moving. */
export const DEFAULT_IMAGE_DURATION_MS = 3_000
/** Photo on-screen time bounds. The floor keeps a photo visible (and its
 * export segment above MIN_SEGMENT_MS); the ceiling keeps the duration
 * strip's drag scale useful. */
export const MIN_IMAGE_DURATION_MS = 500
export const MAX_IMAGE_DURATION_MS = 30_000

/** Clamp a requested photo duration into the supported range, snapped to
 * whole tenths of a second (the resolution the UI shows). Non-finite
 * requests fall back to the default. */
export function clampImageDurationMs(durationMs: number): number {
  if (!Number.isFinite(durationMs)) return DEFAULT_IMAGE_DURATION_MS
  const snapped = Math.round(durationMs / 100) * 100
  return Math.max(MIN_IMAGE_DURATION_MS, Math.min(MAX_IMAGE_DURATION_MS, snapped))
}

export function effectiveDurationMs(clip: Pick<ClipMeta, 'durationMs' | 'trimStartMs' | 'trimEndMs'>): number {
  const end = Math.min(clip.trimEndMs, clip.durationMs)
  const start = Math.max(0, Math.min(clip.trimStartMs, end))
  return Math.max(0, end - start)
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const tenths = Math.floor((ms % 1000) / 100)
  if (minutes > 0) {
    return `${minutes}:${seconds.toString().padStart(2, '0')}.${tenths}`
  }
  return `${seconds}.${tenths}s`
}

export function newId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}_${crypto.randomUUID()}`
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}
