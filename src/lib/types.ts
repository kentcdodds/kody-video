export type ProjectId = string
export type ClipId = string

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
}

export interface ClipMeta {
  id: ClipId
  projectId: ProjectId
  mimeType: string
  durationMs: number
  trimStartMs: number
  trimEndMs: number
  createdAt: number
  width?: number
  height?: number
  thumbWidth?: number
  thumbHeight?: number
  /** Opt-in geolocation captured at recording time (absent on older clips
   * and whenever tagging is off or unavailable). */
  lat?: number
  lng?: number
  locationAccuracyM?: number
  /** Music's share (0–1) of the audio mix while this clip plays: the clip's
   * own sound gets the complement (0.8 music ⇒ 0.2 clip sound), so the mix
   * can never clip. Absent = the project playlist's default share. */
  audioVolume?: number
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
}

/**
 * A project's background music: tracks play one after the other under the
 * clips until the film ends (the last one is cut off there — nothing loops),
 * at a default volume clips can override individually.
 */
export interface ProjectAudioRecord {
  projectId: ProjectId
  tracks: ProjectAudioTrack[]
  /** Music's default share (0–1) of the audio mix for clips without a
   * per-clip override; clip sound gets the complement. */
  defaultVolume: number
  /** Ease the music in at the start of the film (default on). */
  fadeIn: boolean
  /** Ease the music out at the end of the film (default on). */
  fadeOut: boolean
}

/** 25% music / 75% clip sound — sits under speech without drowning it. */
export const DEFAULT_AUDIO_VOLUME = 0.25

/** Total playlist length — what the music can cover before going silent. */
export function projectAudioTotalDurationMs(audio: Pick<ProjectAudioRecord, 'tracks'>): number {
  return audio.tracks.reduce((sum, track) => sum + track.durationMs, 0)
}

export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return DEFAULT_AUDIO_VOLUME
  return Math.max(0, Math.min(1, volume))
}

/** Music's share of the mix while a clip plays: its override or the default. */
export function clipAudioVolume(
  clip: Pick<ClipMeta, 'audioVolume'>,
  defaultVolume: number,
): number {
  return clampVolume(clip.audioVolume ?? defaultVolume)
}

export interface AppMeta {
  key: 'settings'
  maxProjects: number
  lastOpenedProjectId: ProjectId | null
  onboardingDismissed: boolean
  /** One-time "Remove Watermark" purchase (verified via Stripe). */
  watermarkRemoved?: boolean
  purchaseSessionId?: string | null
  /** Opt-in: tag new clips with device location. */
  locationTaggingEnabled?: boolean
  /** The persisted last export (OPFS-backed), recoverable after the share
   * sheet is missed — and served instantly when nothing changed. */
  lastExport?: {
    projectId: ProjectId
    opfsName: string
    mimeType: string
    fileExtension: 'mp4' | 'webm'
    createdAt: number
    /** Fingerprint of the clips (ids + trims) and watermark state that
     * produced the file — any difference means a fresh export is needed. */
    signature: string
    watermarked: boolean
  } | null
}

export const MAX_PROJECTS = 6

/** Projects included without the Kody Video Plus purchase. */
export const FREE_PROJECTS = 1

/** Route id for a project that exists only as a URL until the first clip is
 * recorded — backing out of an empty "new project" leaves nothing behind. */
export const NEW_PROJECT_ID: ProjectId = 'new'

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
