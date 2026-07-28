declare const __COMMIT_SHA__: string | undefined
declare const __BUILD_DATE__: string | undefined

/** Full commit SHA the build was made from ('dev' outside CI/tests). */
export const COMMIT_SHA = typeof __COMMIT_SHA__ === 'string' ? __COMMIT_SHA__ : 'dev'
/** ISO timestamp of when the bundle was built. */
export const BUILD_DATE = typeof __BUILD_DATE__ === 'string' ? __BUILD_DATE__ : ''

export function shortVersion(): string {
  return COMMIT_SHA === 'dev' ? 'dev' : COMMIT_SHA.slice(0, 7)
}

export function buildDateLabel(): string {
  const date = new Date(BUILD_DATE)
  if (Number.isNaN(date.getTime())) return BUILD_DATE
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
