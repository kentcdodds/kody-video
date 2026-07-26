export type ProjectId = string
export type ClipId = string

export interface Project {
  id: ProjectId
  name: string
  createdAt: number
  updatedAt: number
  clipIds: ClipId[]
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
}

export interface ClipRecord extends ClipMeta {
  blob: Blob
}

export interface DeletedClipSnapshot {
  clip: ClipRecord
  index: number
  deletedAt: number
}

export interface AppMeta {
  key: 'settings'
  maxProjects: number
  lastOpenedProjectId: ProjectId | null
}

export const MAX_PROJECTS = 6

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
