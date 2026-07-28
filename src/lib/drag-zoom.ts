/**
 * Drag-to-zoom mapping for hold-to-record.
 *
 * Full-range guarantee: wherever the finger pressed, dragging up to the top
 * of the stage reaches MAX zoom and dragging down to the bottom reaches MIN.
 * Interpolation is exponential (equal travel = equal zoom *ratio*, matching
 * how zoom is perceived), and a floor on the available travel keeps presses
 * near a stage edge from becoming hair-triggers.
 */

interface DragZoomInput {
  /** Finger anchor (press point, possibly re-anchored after the dead zone). */
  anchorY: number
  /** Current pointer position. */
  clientY: number
  stageTop: number
  stageHeight: number
  /** Zoom value when the drag started. */
  start: number
  min: number
  max: number
}

/** Presses closer to an edge than this fraction still get this much travel. */
const MIN_TRAVEL_FRACTION = 0.2

export function dragZoomValue({
  anchorY,
  clientY,
  stageTop,
  stageHeight,
  start,
  min,
  max,
}: DragZoomInput): number {
  const minTravel = stageHeight * MIN_TRAVEL_FRACTION
  const deltaY = anchorY - clientY
  let next: number
  if (deltaY >= 0) {
    const available = Math.max(anchorY - stageTop, minTravel)
    const t = Math.min(1, deltaY / available)
    next = start * (max / start) ** t
  } else {
    const available = Math.max(stageTop + stageHeight - anchorY, minTravel)
    const t = Math.min(1, -deltaY / available)
    next = start * (min / start) ** t
  }
  return Math.min(max, Math.max(min, next))
}
