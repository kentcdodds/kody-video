import {
  addClip,
  clearUndo,
  deleteClip,
  duplicateClip,
  getClipsForProject,
  getProject,
  getUndoSnapshot,
  listProjects,
  moveClip,
  setLastOpenedProjectId,
  undoDeleteLastClip,
  updateClipTrim,
} from './storage'
import {
  effectiveDurationMs,
  type ClipId,
  type ClipRecord,
  type Project,
  type ProjectId,
} from './types'

export interface ProjectSummary extends Project {
  clipCount: number
  durationMs: number
}

export interface ProjectLoaderData {
  project: Project | null
  clips: ClipRecord[]
  canUndo: boolean
  error: string | null
}

export async function loadHomeProjects(): Promise<ProjectSummary[]> {
  const list = await listProjects()
  return Promise.all(
    list.map(async (project) => {
      const clips = await getClipsForProject(project.id)
      const durationMs = clips.reduce((sum, clip) => sum + effectiveDurationMs(clip), 0)
      return {
        ...project,
        clipCount: clips.length,
        durationMs,
      }
    }),
  )
}

export async function loadProjectPage(projectId: ProjectId): Promise<ProjectLoaderData> {
  try {
    const [project, clips, undo] = await Promise.all([
      getProject(projectId),
      getClipsForProject(projectId),
      getUndoSnapshot(projectId),
    ])
    if (!project) {
      return { project: null, clips: [], canUndo: false, error: 'Project not found' }
    }
    await setLastOpenedProjectId(projectId)
    return { project, clips, canUndo: !!undo, error: null }
  } catch (err) {
    return {
      project: null,
      clips: [],
      canUndo: false,
      error: err instanceof Error ? err.message : 'Failed to load project',
    }
  }
}

export async function appendRecording(
  projectId: ProjectId,
  input: { blob: Blob; mimeType: string; durationMs: number },
): Promise<ClipRecord> {
  const clip = await addClip({
    projectId,
    blob: input.blob,
    mimeType: input.mimeType,
    durationMs: input.durationMs,
  })
  await clearUndo(projectId)
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
