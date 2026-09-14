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
 * a restart seek, so the restarting flag can clear even if `seeked` is late. */
export function restartSeekHasLanded(currentTime: number, startSec: number): boolean {
  return Math.abs(currentTime - startSec) <= 0.12
}
