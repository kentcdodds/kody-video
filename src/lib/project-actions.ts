import {
  addClip,
  clearUndo,
  deleteClip,
  duplicateClip,
  getClipsForProject,
  getProject,
  getSettings,
  getUndoSnapshot,
  listProjects,
  moveClip,
  setLastOpenedProjectId,
  undoDeleteLastClip,
  updateClipThumbs,
  updateClipTrim,
} from './storage'
import { estimateExportCacheBytes } from './export/export-cache'
import { estimateStorageSpace, type StorageSpace } from './storage-space'
import { ensureClipThumbs, type GeneratedThumbs } from './thumbs'
import {
  NEW_PROJECT_ID,
  effectiveDurationMs,
  type ClipId,
  type ClipRecord,
  type Project,
  type ProjectId,
} from './types'

export interface ProjectSummary extends Project {
  clipCount: number
  durationMs: number
  /** First available clip thumbnail, for the project slot background. */
  posterThumb: Blob | null
}

export interface ProjectLoaderData {
  project: Project | null
  clips: ClipRecord[]
  canUndo: boolean
  onboardingDismissed: boolean
  /** True when the one-time "Remove Watermark" purchase is unlocked. */
  watermarkRemoved: boolean
  /** Device storage estimate (null when the API is unavailable). */
  storage: StorageSpace | null
  /** Opt-in: tag new clips with device location. */
  locationTaggingEnabled: boolean
  error: string | null
}

export interface HomeLoaderData {
  projects: ProjectSummary[]
  storage: StorageSpace | null
  /** Bytes held by cached export files (recoverable last export, scratch). */
  exportCacheBytes: number
  /** True when the one-time Kody Video Plus purchase is unlocked. */
  plus: boolean
}

export async function loadHomePage(): Promise<HomeLoaderData> {
  const [projects, storage, exportCacheBytes, settings] = await Promise.all([
    loadHomeProjects(),
    estimateStorageSpace(),
    estimateExportCacheBytes(),
    getSettings(),
  ])
  return { projects, storage, exportCacheBytes, plus: settings.watermarkRemoved === true }
}

export async function loadHomeProjects(): Promise<ProjectSummary[]> {
  const list = await listProjects()
  // Stable slot order (creation order) — OK Video-style fixed project slots
  // that don't shuffle every time you open a project.
  list.sort((a, b) => a.createdAt - b.createdAt)
  return Promise.all(
    list.map(async (project) => {
      const clips = await getClipsForProject(project.id)
      const durationMs = clips.reduce((sum, clip) => sum + effectiveDurationMs(clip), 0)
      // Prefer any clip with a high-res poster over an older thumbs-only one.
      const withPoster = clips.find((clip) => clip.poster)
      const withThumb = clips.find((clip) => clip.thumbs && clip.thumbs.length > 0)
      return {
        ...project,
        clipCount: clips.length,
        durationMs,
        posterThumb: withPoster?.poster ?? withThumb?.thumbs?.[0] ?? null,
      }
    }),
  )
}

export async function loadProjectPage(projectId: ProjectId): Promise<ProjectLoaderData> {
  try {
    // A "new" project lives only in the URL until the first clip is
    // recorded — nothing is persisted, so backing out leaves nothing behind.
    if (projectId === NEW_PROJECT_ID) {
      const [projects, settings, storage] = await Promise.all([
        listProjects(),
        getSettings(),
        estimateStorageSpace(),
      ])
      const now = Date.now()
      return {
        project: {
          id: NEW_PROJECT_ID,
          name: `Project ${projects.length + 1}`,
          createdAt: now,
          updatedAt: now,
          clipIds: [],
        },
        clips: [],
        canUndo: false,
        onboardingDismissed: settings.onboardingDismissed,
        watermarkRemoved: settings.watermarkRemoved === true,
        storage,
        locationTaggingEnabled: settings.locationTaggingEnabled === true,
        error: null,
      }
    }

    const [project, clips, undo, settings, storage] = await Promise.all([
      getProject(projectId),
      getClipsForProject(projectId),
      getUndoSnapshot(projectId),
      getSettings(),
      estimateStorageSpace(),
    ])
    if (!project) {
      return {
        project: null,
        clips: [],
        canUndo: false,
        onboardingDismissed: settings.onboardingDismissed,
        watermarkRemoved: settings.watermarkRemoved === true,
        storage,
        locationTaggingEnabled: settings.locationTaggingEnabled === true,
        error: 'Project not found',
      }
    }
    await setLastOpenedProjectId(projectId)
    // Backfill filmstrip thumbnails for clips that lack them. Serially —
    // Android caps concurrent video decoders hard, and this normally touches
    // at most the clip that was just recorded.
    const hydrated: ClipRecord[] = []
    for (const clip of clips) {
      hydrated.push(await ensureClipThumbs(clip))
    }
    return {
      project,
      clips: hydrated,
      canUndo: !!undo,
      onboardingDismissed: settings.onboardingDismissed,
      watermarkRemoved: settings.watermarkRemoved === true,
      storage,
      locationTaggingEnabled: settings.locationTaggingEnabled === true,
      error: null,
    }
  } catch (err) {
    return {
      project: null,
      clips: [],
      canUndo: false,
      onboardingDismissed: true,
      watermarkRemoved: false,
      storage: null,
      locationTaggingEnabled: false,
      error: err instanceof Error ? err.message : 'Failed to load project',
    }
  }
}

export async function appendRecording(
  projectId: ProjectId,
  input: {
    blob: Blob
    mimeType: string
    durationMs: number
    width?: number
    height?: number
    lat?: number
    lng?: number
    locationAccuracyM?: number
  },
  options?: {
    /** Poster/thumb captured from the live preview at take end — persisting
     * them here means the loader backfill never has to decode the fresh
     * blob behind the live camera (the post-take black flash). */
    capturedThumbs?: GeneratedThumbs | null
  },
): Promise<ClipRecord> {
  const clip = await addClip({
    projectId,
    blob: input.blob,
    mimeType: input.mimeType,
    durationMs: input.durationMs,
    width: input.width,
    height: input.height,
    lat: input.lat,
    lng: input.lng,
    locationAccuracyM: input.locationAccuracyM,
  })
  if (options?.capturedThumbs) {
    // Best-effort: on a (rare) persistence failure the loader backfill
    // still generates thumbs — one black flash beats missing artwork. The
    // returned record is NOT decorated in memory: callers revalidate from
    // the store, and claiming unsaved thumbs would mask exactly that
    // fallback.
    await updateClipThumbs(clip.id, options.capturedThumbs).catch(() => undefined)
  }
  await clearUndo(projectId)
  // Thumbnails are generated by the loader backfill on the next revalidation.
  return clip
}

export async function removeClip(clipId: ClipId): Promise<void> {
  await deleteClip(clipId)
}

export async function undoLastDelete(projectId: ProjectId): Promise<ClipRecord | null> {
  return undoDeleteLastClip(projectId)
}

export async function duplicateSelectedClip(clipId: ClipId): Promise<ClipRecord> {
  return duplicateClip(clipId)
}

export async function moveSelectedClip(
  projectId: ProjectId,
  clipId: ClipId,
  direction: 'left' | 'right',
): Promise<void> {
  await moveClip(projectId, clipId, direction)
}

export async function trimClip(
  clipId: ClipId,
  trimStartMs: number,
  trimEndMs: number,
): Promise<void> {
  await updateClipTrim(clipId, trimStartMs, trimEndMs)
}
