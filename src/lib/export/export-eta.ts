/**
 * Remaining time from progress so far, measured from the first progress
 * report (setup before encoding — decoder waits, probing — is excluded).
 * Null until there is enough signal to avoid a wild first guess.
 */
export function estimateRemainingMs(options: {
  startProgress: number
  progress: number
  elapsedMs: number
}): number | null {
  const { startProgress, progress, elapsedMs } = options
  const done = progress - startProgress
  if (!(progress < 1) || !(done >= 0.03) || !(elapsedMs >= 2000)) return null
  return (elapsedMs * (1 - progress)) / done
}

export function formatTimeLeft(remainingMs: number): string {
  const seconds = remainingMs / 1000
  if (seconds < 10) return 'A few seconds left'
  const roundedSeconds = Math.ceil(seconds / 5) * 5
  if (roundedSeconds < 60) return `About ${roundedSeconds} sec left`
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return `About ${minutes} min left`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `About ${hours} hr left` : `About ${hours} hr ${rest} min left`
}
