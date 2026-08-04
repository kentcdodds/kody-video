/**
 * Version info, vanilla edition: there is no bundler to stamp a commit SHA,
 * so the version is a hand-maintained string. Keep it in sync with
 * CACHE_VERSION in /sw.js when shipping changes (that's what invalidates
 * the offline cache).
 */
export const APP_VERSION = 'vanilla-1'
export const BUILD_DATE = '2026-08-04T00:00:00.000Z'

export function shortVersion() {
  return APP_VERSION
}

export function buildDateLabel() {
  const date = new Date(BUILD_DATE)
  if (Number.isNaN(date.getTime())) return BUILD_DATE
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}
