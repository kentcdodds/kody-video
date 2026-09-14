/** Whether a timeupdate should treat the playhead as at the kept-window
 * end. Stale events while seeking (or while a restart-to-start is in
 * flight) must not pause a play that just began. */
export function isAtKeptWindowEnd(
  currentTime: number,
  endSec: number,
  options: { seeking: boolean; restarting: boolean; epsilon?: number },
): boolean {
  if (options.seeking || options.restarting) return false
  return currentTime >= endSec - (options.epsilon ?? 0.02)
}

/** True when currentTime has landed back in the kept window's start after
 * a restart seek, so the restarting flag can clear even if `seeked` is late.
 * Must not treat a stale playhead still at the kept end as landed — short
 * clips can be shorter than the start-proximity slack. */
export function restartSeekHasLanded(
  currentTime: number,
  startSec: number,
  endSec: number,
): boolean {
  if (currentTime >= endSec - 0.02) return false
  return Math.abs(currentTime - startSec) <= 0.12
}
