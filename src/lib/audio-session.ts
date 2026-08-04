import { isIosBrowser } from './platform'

/**
 * iOS external-microphone routing (DJI transmitters, AirPods, wired headsets).
 *
 * WebKit captures from whatever input the audio session routes to, and by
 * default that pins the BUILT-IN mic even when an external microphone is
 * connected — the native camera app uses it, the web app doesn't. The one
 * lever the web has is the (WebKit-only) `navigator.audioSession` API:
 * setting `type = 'play-and-record'` AFTER capture starts kicks iOS into
 * re-routing input to the connected external device. Setting it BEFORE
 * capture is 50/50, so the call must follow the getUserMedia grant.
 *
 * The session is left sticky after capture ends, which degrades playback
 * output quality — resetting `'playback'` then `'auto'` on release restores
 * hi-fi output. Both calls are feature-detected no-ops off iOS.
 */

interface AudioSessionLike {
  type: string
}

function audioSession(): AudioSessionLike | null {
  if (!isIosBrowser()) return null
  const session = (navigator as { audioSession?: AudioSessionLike }).audioSession
  return session ?? null
}

/** Call right after a mic-carrying stream is adopted. */
export function engageRecordAudioSession(): void {
  const session = audioSession()
  if (!session) return
  try {
    session.type = 'play-and-record'
  } catch {
    // Unsupported value on this WebKit build — routing stays as-is.
  }
}

/** Call after the mic-carrying stream is stopped. */
export function releaseRecordAudioSession(): void {
  const session = audioSession()
  if (!session) return
  try {
    session.type = 'playback'
    session.type = 'auto'
  } catch {
    // Best-effort restore.
  }
}
