import { orientationFromSize } from './clip-fit'
import { isCoarsePointerDevice, viewportIsLandscape } from './platform'
import { getProject, setProjectOrientation } from './storage'
import type { ClipRecord, ProjectId, ProjectOrientation } from './types'

/**
 * The first clip sets the film's orientation. On a phone, how the device
 * is held wins: camera tracks are often landscape pixels even when the
 * user is recording upright. Imports and desktop use the clip's pixels
 * (viewport only when size is unknown on a held device). Later clips
 * never overwrite a choice. Landscape still requires Plus — a gated
 * write leaves the project portrait and the take is kept.
 */
export async function lockOrientationFromFirstClip(
  projectId: ProjectId,
  clip: Pick<ClipRecord, 'width' | 'height'>,
  options?: { preferHeldOrientation?: boolean },
): Promise<void> {
  const project = await getProject(projectId)
  if (!project || project.clipIds.length !== 1) return
  const fromClip = orientationFromSize(clip.width, clip.height)
  const held: ProjectOrientation | null = isCoarsePointerDevice()
    ? viewportIsLandscape()
      ? 'landscape'
      : 'portrait'
    : null
  const chosen = options?.preferHeldOrientation
    ? (held ?? fromClip)
    : (fromClip ?? held)
  if (!chosen) return
  await setProjectOrientation(projectId, chosen).catch(() => undefined)
}
