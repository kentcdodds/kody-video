/** Pure zoom-chip math for the record screen's quick-zoom buttons. */

export interface ZoomRangeLike {
  min: number
  max: number
}

/**
 * Chips stop here even when the camera's digital zoom goes much further
 * (phones advertise 30×+ of super-res mush). The full hardware range stays
 * reachable — drag-to-zoom spans the camera's TRUE max; only the one-tap
 * presets are capped at a value that still looks good.
 */
export const ZOOM_CHIP_MAX = 10

/** Build a small set of zoom chip levels clamped to device min and the
 * chip cap (e.g. 0.5×, 1×, 2×, 10×). */
export function zoomChipLevels(zoom: ZoomRangeLike): number[] {
  const { min, max } = zoom
  // The cap never dips below the device minimum — a hypothetical 12–30×
  // range must not produce a 10× chip the camera can't reach.
  const chipMax = Math.min(max, Math.max(ZOOM_CHIP_MAX, min))
  const candidates = [1, 2]
  if (chipMax > 2.05) {
    const rounded = Math.round(chipMax)
    // Prefer a clean integer near the cap (4×/5×); otherwise the exact value.
    candidates.push(Math.abs(rounded - chipMax) <= 0.35 ? rounded : Number(chipMax.toFixed(1)))
  }
  const levels = candidates
    .map((level) => Math.min(chipMax, Math.max(min, level)))
    .filter((level, index, arr) => arr.findIndex((other) => Math.abs(other - level) < 0.05) === index)
    .sort((a, b) => a - b)
  // Always include device min when it isn't already represented (ultra-wide lenses).
  if (levels.every((level) => Math.abs(level - min) > 0.05)) {
    levels.unshift(min)
  }
  return levels
}

export function formatZoomLabel(level: number): string {
  const rounded = Math.round(level * 10) / 10
  if (Number.isInteger(rounded)) return `${rounded}×`
  return `${rounded.toFixed(1)}×`
}

export function nearestZoomLevel(levels: number[], value: number): number {
  let best = levels[0]!
  let bestDist = Math.abs(value - best)
  for (const level of levels) {
    const dist = Math.abs(value - level)
    if (dist < bestDist) {
      best = level
      bestDist = dist
    }
  }
  return best
}
