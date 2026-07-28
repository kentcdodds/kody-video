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

export type UpdateCheckResult = 'updated' | 'current' | 'unavailable'

/**
 * Ask the service worker for a new version right now. When one is found it
 * is applied immediately (the page reloads into the new version) — the user
 * explicitly asked, so no extra confirmation step.
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (!registration || !applyUpdate) return 'unavailable'
  try {
    await registration.update()
  } catch {
    // Offline or the update request failed — report the truth: no update.
    return 'unavailable'
  }
  // A found update passes through installing → waiting; give it a moment.
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (registration.waiting) {
      await applyUpdate(true)
      return 'updated'
    }
    if (!registration.installing) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  if (registration.waiting) {
    await applyUpdate(true)
    return 'updated'
  }
  return 'current'
}
