/**
 * Captures the browser's install prompt (Chrome fires `beforeinstallprompt`
 * once, early) so the home screen can offer a proper "Install" button.
 * Imported for its side effect from main.tsx before the app renders.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferredPrompt: BeforeInstallPromptEvent | null = null
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((listener) => listener())
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    deferredPrompt = event as BeforeInstallPromptEvent
    notify()
  })
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    notify()
  })
}

export function canPromptInstall(): boolean {
  return deferredPrompt !== null
}

export function subscribeInstallPrompt(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export async function promptInstall(): Promise<boolean> {
  const prompt = deferredPrompt
  if (!prompt) return false
  await prompt.prompt()
  const choice = await prompt.userChoice
  if (choice.outcome === 'accepted') {
    deferredPrompt = null
    notify()
  }
  return choice.outcome === 'accepted'
}
