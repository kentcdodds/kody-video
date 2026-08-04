/**
 * Manual update checking for the About page. The service worker registration
 * and the apply function come from the `useRegisterSW` hook in app.tsx; this
 * module just holds them so any screen can trigger a check.
 */

let registration: ServiceWorkerRegistration | null = null
let applyUpdate: ((reloadPage?: boolean) => Promise<void>) | null = null

export function registerUpdateHandles(
  reg: ServiceWorkerRegistration | null | undefined,
  apply: (reloadPage?: boolean) => Promise<void>,
): void {
  registration = reg ?? null
  applyUpdate = apply
}

export type UpdateCheckResult = 'updated' | 'current' | 'downloading' | 'unavailable'

/**
 * Ask the service worker for a new version right now. When one is found it
 * is applied immediately (the page reloads into the new version) — the user
 * explicitly asked, so no extra confirmation step. A slow install that
 * outlives the wait reports 'downloading'; the standard update toast offers
 * it when it finishes.
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const reg = registration
  const apply = applyUpdate
  if (!reg || !apply) return 'unavailable'
  try {
    await reg.update()
  } catch {
    // Offline or the update request failed — report the truth: no update.
    return 'unavailable'
  }
  // update() can resolve before a found worker shows up on `installing` —
  // give the updatefound event a grace window before concluding "current".
  const workerAppeared =
    Boolean(reg.installing || reg.waiting) ||
    (await new Promise<boolean>((resolve) => {
      const onFound = () => {
        cleanup()
        resolve(true)
      }
      const timer = setTimeout(() => {
        cleanup()
        resolve(false)
      }, 1500)
      const cleanup = () => {
        reg.removeEventListener('updatefound', onFound)
        clearTimeout(timer)
      }
      reg.addEventListener('updatefound', onFound)
    }))
  if (!workerAppeared) return 'current'

  // Follow the install through to `waiting`, then apply.
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (reg.waiting) return applyAndReload(apply)
    if (!reg.installing) {
      // A worker appeared but is neither installing nor waiting anymore:
      // the install failed (worker went redundant). Don't claim "current".
      if (!reg.waiting) return 'unavailable'
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  if (reg.waiting) return applyAndReload(apply)
  if (reg.installing) return 'downloading'
  return 'current'
}

async function applyAndReload(
  apply: (reloadPage?: boolean) => Promise<void>,
): Promise<UpdateCheckResult> {
  try {
    await apply(true)
  } catch {
    return 'unavailable'
  }
  // Normally clientsClaim + controllerchange reload the page before this
  // fires; service workers deployed before clientsClaim never emit
  // controllerchange, which left the button looking dead. The new worker
  // has been told to activate either way — reload under it.
  window.setTimeout(() => {
    window.location.reload()
  }, 1500)
  return 'updated'
}
