import {
  addClip,
  addProjectAudioTrack,
  clearUndo,
  deleteClip,
  discardClip,
  deleteProjectIfPristine,
  duplicateClip,
  getClip,
  getClipsForProject,
  getProject,
  getProjectAudio,
  getSettings,
  getUndoSnapshot,
  listProjects,
  moveClip,
  removeProjectAudioTrack,
  replaceClipMedia,
  setLastOpenedProjectId,
  setProjectOrientation,
  undoDeleteLastClip,
  updateClipDuration,
  updateClipFit,
  updateClipSize,
  updateClipThumbs,
  updateClipTrim,
  updateClipVolumes,
  updateProjectAudioTrack,
  type ClipVolumeSettings,
  type ProjectAudioTrackSettings,
} from './storage'
import { isOrientationSwap, sizeMatchingHold } from './clip-fit'
import { probeVideoElementSize, probeVideoFileSize } from './clip-media'
import { lockOrientationFromFirstClip } from './orientation-lock'
import { heldDeviceOrientation } from './platform'
import { probeAudioFile } from './audio-import'
import { estimateExportCacheBytes } from './export/export-cache'
import { estimateStorageSpace, type StorageSpace } from './storage-space'
import { resolveVideoQuality } from './video-quality'
import type { GeneratedThumbs } from './thumbs'
import { canSplitClip, clipHasUnusedMedia, remapTrimToSlice, resolveSplitMs } from './clip-edit'
import {
  NEW_PROJECT_ID,
  effectiveDurationMs,
  isImageClip,
  type ClipFit,
  type ClipId,
  type ClipRecord,
  type Project,
  type ProjectAudioRecord,
  type ProjectId,
  type ProjectOrientation,
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
  /** Background-audio track played under the clips (null when none is set). */
  audio: ProjectAudioRecord | null
  canUndo: boolean
  onboardingDismissed: boolean
  /** True when the one-time Kody Video Plus purchase is unlocked. */
  watermarkRemoved: boolean
  /**
   * Plus opt-in: keep the Kody mark on exports after purchase (default off).
   */
  keepWatermark: boolean
  /** Plus opt-in: include captured coordinates in MP4 exports (default off). */
  includeLocationInExports: boolean
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
  /** Home "Watch the tour" card dismissed (first-timer teaser). */
  tourCardDismissed: boolean
  /** Capture quality for new recordings (missing = high). */
  videoQuality: 'high' | 'standard' | 'saver'
}

export async function loadHomePage(): Promise<HomeLoaderData> {
  const [projects, storage, exportCacheBytes, settings] = await Promise.all([
    loadHomeProjects(),
    estimateStorageSpace(),
    estimateExportCacheBytes(),
    getSettings(),
  ])
  return {
    projects,
    storage,
    exportCacheBytes,
    plus: settings.watermarkRemoved === true,
    tourCardDismissed: settings.tourCardDismissed === true,
    videoQuality: resolveVideoQuality(settings.videoQuality),
  }
}

export async function loadHomeProjects(): Promise<ProjectSummary[]> {
  const all = await listProjects()
  // Exiting a project still in its default state (no clips, default name,
  // no music) must leave nothing behind, just like backing out of
  // /project/new. Every exit path lands back here, so such projects are
  // silently deleted before the slots render.
  const list: Project[] = []
  for (const project of all) {
    if (project.clipIds.length === 0 && (await deleteProjectIfPristine(project.id))) continue
    list.push(project)
  }
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
        audio: null,
        canUndo: false,
        onboardingDismissed: settings.onboardingDismissed,
        watermarkRemoved: settings.watermarkRemoved === true,
        keepWatermark: settings.keepWatermark === true,
        includeLocationInExports:
          settings.watermarkRemoved === true && settings.includeLocationInExports === true,
        storage,
        locationTaggingEnabled:
          settings.watermarkRemoved === true && settings.locationTaggingEnabled === true,
        error: null,
      }
    }

    const [project, clips, audio, undo, settings, storage] = await Promise.all([
      getProject(projectId),
      getClipsForProject(projectId),
      getProjectAudio(projectId),
      getUndoSnapshot(projectId),
      getSettings(),
      estimateStorageSpace(),
    ])
    if (!project) {
      return {
        project: null,
        clips: [],
        audio: null,
        canUndo: false,
        onboardingDismissed: settings.onboardingDismissed,
        watermarkRemoved: settings.watermarkRemoved === true,
        keepWatermark: settings.keepWatermark === true,
        includeLocationInExports:
          settings.watermarkRemoved === true && settings.includeLocationInExports === true,
        storage,
        locationTaggingEnabled:
          settings.watermarkRemoved === true && settings.locationTaggingEnabled === true,
        error: 'Project not found',
      }
    }
    await setLastOpenedProjectId(projectId)
    // Return stored clips immediately so the timeline can paint. Thumb and
    // audio-peak backfill runs after first paint (hydrateProjectClips) —
    // waiting here is what made "Clip added" land before the tile appeared.
    return {
      project,
      clips,
      audio: audio ?? null,
      canUndo: !!undo,
      onboardingDismissed: settings.onboardingDismissed,
      watermarkRemoved: settings.watermarkRemoved === true,
      keepWatermark: settings.keepWatermark === true,
      includeLocationInExports:
        settings.watermarkRemoved === true && settings.includeLocationInExports === true,
      storage,
      locationTaggingEnabled:
        settings.watermarkRemoved === true && settings.locationTaggingEnabled === true,
      error: null,
    }
  } catch (err) {
    return {
      project: null,
      clips: [],
      audio: null,
      canUndo: false,
      onboardingDismissed: true,
      watermarkRemoved: false,
      keepWatermark: false,
      includeLocationInExports: false,
      storage: null,
      locationTaggingEnabled: false,
      error: err instanceof Error ? err.message : 'Failed to load project',
    }
  }
}

/** Generate missing filmstrip thumbs and audio-peak measurements, and
 * correct stored pixel size from the file (camera track settings often
 * stay at the session-start sensor size). Serial because Android caps
 * concurrent video decoders. Safe to call after the first paint — tiles
 * already render with placeholders. */
export async function hydrateProjectClips(clips: ClipRecord[]): Promise<ClipRecord[]> {
  if (clips.length === 0) return clips
  const { ensureClipThumbs } = await import('./thumbs')
  const { ensureClipAudioPeak } = await import('./clip-audio-peak')
  const hydrated: ClipRecord[] = []
  for (const clip of clips) {
    hydrated.push(await ensureClipAudioPeak(await ensureClipThumbs(await ensureClipDisplaySize(clip))))
  }
  return hydrated
}

/** Reconcile stored width/height with the file's display size. Photos
 * already come from a bitmap decode, so they are left alone. The
 * container parse is trusted; a `<video>` fallback must not 90°-swap a
 * size we already stored (Android reports the current hold, not the file). */
export async function ensureClipDisplaySize(clip: ClipRecord): Promise<ClipRecord> {
  if (isImageClip(clip)) return clip
  const fromFile = await probeVideoFileSize(clip.blob).catch(() => null)
  if (fromFile) {
    if (clip.width === fromFile.width && clip.height === fromFile.height) return clip
    await updateClipSize(clip.id, fromFile.width, fromFile.height).catch(() => undefined)
    return { ...clip, width: fromFile.width, height: fromFile.height }
  }
  const fromElement = await probeVideoElementSize(clip.blob).catch(() => null)
  if (!fromElement) return clip
  if (clip.width === fromElement.width && clip.height === fromElement.height) return clip
  if (isOrientationSwap(clip, fromElement)) return clip
  await updateClipSize(clip.id, fromElement.width, fromElement.height).catch(() => undefined)
  return { ...clip, width: fromElement.width, height: fromElement.height }
}

export async function appendRecording(
  projectId: ProjectId,
  input: {
    blob: Blob
    mimeType: string
    durationMs: number
    /** Default trim-in (warm-encoder pre-roll sits before the press). */
    trimStartMs?: number
    /** Default trim-out (recordings end their kept range at the release
     * point; the media itself runs a stop-grace longer). */
    trimEndMs?: number
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
  // Prefer the encoded file's display size. Phone camera tracks often keep
  // reporting the session-start sensor size after the device is rotated,
  // which made landscape takes look like portrait (and vice versa). When
  // the container cannot be parsed, swap the track size to the hold.
  const fromFile = await probeVideoFileSize(input.blob).catch(() => null)
  const fallback = sizeMatchingHold(input.width, input.height, heldDeviceOrientation())
  const width = fromFile?.width ?? fallback.width
  const height = fromFile?.height ?? fallback.height
  const clip = await addClip({
    projectId,
    blob: input.blob,
    mimeType: input.mimeType,
    durationMs: input.durationMs,
    trimStartMs: input.trimStartMs,
    trimEndMs: input.trimEndMs,
    width,
    height,
    lat: input.lat,
    lng: input.lng,
    locationAccuracyM: input.locationAccuracyM,
  })
  await lockOrientationFromFirstClip(projectId, clip, { preferHeldOrientation: true })
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

/** Bake the saved trim into the file and drop the unused head/tail. */
export async function permanentlyTrimClip(clipId: ClipId): Promise<ClipRecord> {
  const clip = await getClip(clipId)
  if (!clip) throw new Error('Clip not found')
  if (isImageClip(clip)) throw new Error('Photos have no unused video to delete')
  if (!clipHasUnusedMedia(clip)) throw new Error('This clip is already kept in full')

  const startMs = Math.max(0, clip.trimStartMs)
  const endMs = Math.min(clip.trimEndMs, clip.durationMs)
  const { sliceClipMedia } = await import('./clip-media')
  const sliced = await sliceClipMedia(clip.blob, startMs, endMs, clip.mimeType)
  const updated = await replaceClipMedia(clipId, {
    blob: sliced.blob,
    mimeType: sliced.mimeType,
    durationMs: sliced.durationMs,
    width: sliced.width ?? clip.width,
    height: sliced.height ?? clip.height,
  })
  await clearUndo(clip.projectId)
  return decorateSlicedClip(updated)
}

/** Cut the clip into two timeline pieces at `playheadMs` (or the kept midpoint). */
export async function splitSelectedClip(
  clipId: ClipId,
  playheadMs: number | null,
): Promise<{ first: ClipRecord; second: ClipRecord }> {
  const clip = await getClip(clipId)
  if (!clip) throw new Error('Clip not found')
  if (!canSplitClip(clip)) throw new Error('This clip is too short to split')

  const splitMs = resolveSplitMs(clip, playheadMs)
  const { sliceClipMedia } = await import('./clip-media')
  const [left, right] = await Promise.all([
    sliceClipMedia(clip.blob, 0, splitMs, clip.mimeType),
    sliceClipMedia(clip.blob, splitMs, clip.durationMs, clip.mimeType),
  ])

  const firstTrim = remapTrimToSlice(clip, 0, left.durationMs)
  const secondTrim = remapTrimToSlice(clip, splitMs, right.durationMs)

  // Insert the right-hand piece first so a failed replace leaves the
  // original clip intact (the extra tail can be deleted). Replacing first
  // would drop the second half if addClip then failed.
  const second = await addClip({
    projectId: clip.projectId,
    blob: right.blob,
    mimeType: right.mimeType,
    durationMs: right.durationMs,
    trimEndMs: secondTrim.trimEndMs,
    width: right.width ?? clip.width,
    height: right.height ?? clip.height,
    createdAt: clip.createdAt,
    afterClipId: clip.id,
    clipVolume: clip.clipVolume,
    musicVolume: clip.musicVolume,
    lat: clip.lat,
    lng: clip.lng,
    locationAccuracyM: clip.locationAccuracyM,
  })
  let first: ClipRecord
  try {
    first = await replaceClipMedia(clipId, {
      blob: left.blob,
      mimeType: left.mimeType,
      durationMs: left.durationMs,
      trimStartMs: firstTrim.trimStartMs,
      trimEndMs: firstTrim.trimEndMs,
      width: left.width ?? clip.width,
      height: left.height ?? clip.height,
    })
  } catch (error) {
    // discardClip (not deleteClip) so a failed split cannot overwrite a
    // real undo snapshot with the orphaned right-hand half.
    await discardClip(second.id).catch(() => undefined)
    throw error
  }
  if (secondTrim.trimStartMs > 0) {
    await updateClipTrim(second.id, secondTrim.trimStartMs, secondTrim.trimEndMs)
    second.trimStartMs = secondTrim.trimStartMs
    second.trimEndMs = secondTrim.trimEndMs
  }
  await clearUndo(clip.projectId)
  return {
    first: await decorateSlicedClip(first),
    second: await decorateSlicedClip(second),
  }
}

async function decorateSlicedClip(clip: ClipRecord): Promise<ClipRecord> {
  const { ensureClipThumbs } = await import('./thumbs')
  const { ensureClipAudioPeak } = await import('./clip-audio-peak')
  return ensureClipAudioPeak(await ensureClipThumbs(clip))
}

/** Set a photo clip's on-screen duration (can grow as well as shrink). */
export async function setClipDuration(clipId: ClipId, durationMs: number): Promise<void> {
  await updateClipDuration(clipId, durationMs)
}

/** Append a picked audio file to the project's background-music playlist. */
export async function addProjectAudioFromFile(
  file: File,
  ensureProjectId: () => Promise<ProjectId>,
): Promise<ProjectAudioRecord> {
  // Probe first: a bad pick on /project/new must not create an empty project.
  const probed = await probeAudioFile(file)
  const projectId = await ensureProjectId()
  return addProjectAudioTrack({
    projectId,
    blob: probed.blob,
    mimeType: probed.mimeType,
    durationMs: probed.durationMs,
    name: probed.name,
  })
}

export async function removeAudioTrack(projectId: ProjectId, trackId: string): Promise<void> {
  await removeProjectAudioTrack(projectId, trackId)
}

/** Update one playlist track's playback settings (trim, level, fades). */
export async function setAudioTrackSettings(
  projectId: ProjectId,
  trackId: string,
  settings: ProjectAudioTrackSettings,
): Promise<void> {
  await updateProjectAudioTrack(projectId, trackId, settings)
}

/** Set a clip's volume levels (1 or null clears the stored override). */
export async function setClipVolumes(
  clipId: ClipId,
  volumes: ClipVolumeSettings,
): Promise<void> {
  await updateClipVolumes(clipId, volumes)
}

/** Crop is the default; letterbox is the stored override. */
export async function setClipFit(clipId: ClipId, fit: ClipFit): Promise<void> {
  await updateClipFit(clipId, fit)
}

/** Change the film's export orientation. Landscape requires Plus. */
export async function setFilmOrientation(
  projectId: ProjectId,
  orientation: ProjectOrientation,
): Promise<void> {
  await setProjectOrientation(projectId, orientation)
}

export {
  DEVICE_CLIP_ACCEPT,
  importDeviceClips,
  type DeviceClipImportResult,
} from './import-device-clips'
