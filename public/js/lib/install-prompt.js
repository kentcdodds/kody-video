/**
 * Captures the browser's install prompt (Chrome fires `beforeinstallprompt`
 * once, early) so the home screen can offer a proper "Install" button.
 * Imported for its side effect from main.tsx before the app renders.
 */
let deferredPrompt = null;
const listeners = new Set();
function notify() {
    listeners.forEach((listener) => listener());
}
if (typeof window !== 'undefined') {
    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        deferredPrompt = event;
        notify();
    });
    window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        notify();
    });
}
export function canPromptInstall() {
    return deferredPrompt !== null;
}
export function subscribeInstallPrompt(listener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
export async function promptInstall() {
    const prompt = deferredPrompt;
    if (!prompt)
        return false;
    // The event is one-shot: consumed by prompt() regardless of the outcome.
    // Drop it either way; the browser refires beforeinstallprompt when the
    // app is still installable.
    deferredPrompt = null;
    notify();
    try {
        await prompt.prompt();
        const choice = await prompt.userChoice;
        return choice.outcome === 'accepted';
    }
    catch {
        return false;
    }
}
