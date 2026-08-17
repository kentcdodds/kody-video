import type { ClipFit, ProjectOrientation } from './types'

/** Stored override, or crop when the clip has never been toggled. */
export function clipFit(clip: { fit?: ClipFit }): ClipFit {
  return clip.fit === 'letterbox' ? 'letterbox' : 'crop'
}

/** Canvas / CSS object-fit for a clip (crop covers, letterbox contains). */
export function clipCanvasFit(clip: { fit?: ClipFit }): 'cover' | 'contain' {
  return clipFit(clip) === 'letterbox' ? 'contain' : 'cover'
}

/** Pixel orientation of a clip. Null when size is missing or square. */
export function orientationFromSize(
  width?: number,
  height?: number,
): ProjectOrientation | null {
  if (!(width && height) || width === height) return null
  return width > height ? 'landscape' : 'portrait'
}

/**
 * True when the clip's pixels disagree with the film, so crop or letterbox
 * will actually change what is kept. Square / unknown size matches both.
 */
export function clipMismatchesFilm(
  clip: { width?: number; height?: number },
  film: ProjectOrientation,
): boolean {
  const clipOrientation = orientationFromSize(clip.width, clip.height)
  return clipOrientation !== null && clipOrientation !== film
}

/** Which timeline badge to show, if any. */
export function clipFitBadge(
  clip: { width?: number; height?: number; fit?: ClipFit },
  film: ProjectOrientation,
): ClipFit | null {
  if (!clipMismatchesFilm(clip, film)) return null
  return clipFit(clip)
}
