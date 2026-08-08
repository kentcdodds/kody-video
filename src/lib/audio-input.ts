/**
 * Microphone (audio input) selection. Phones and desktops often expose more
 * than one mic — built-in, wired headset, Bluetooth, USB interfaces — and the
 * browser default is not always the one the user wants on a take. The record
 * screen offers a chooser when more than one input exists; the choice is
 * remembered across sessions and every capture path (per-take mic, iOS
 * combined stream, screen-recording narration) resolves it before opening.
 */

export interface AudioInputOption {
  id: string
  /** Empty until the user has granted microphone permission. */
  label: string
}

const AUDIO_INPUT_STORAGE_KEY = 'kodyVideo.audioInput'

interface RememberedAudioInput {
  id: string
  /** Device ids rotate when the browser clears site data; the label lets
   * the same physical mic be re-matched afterwards. */
  label: string
}

export async function listAudioInputs(): Promise<AudioInputOption[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    // Pre-permission enumerations return placeholder entries with empty
    // ids — not openable, not choosable.
    const mics = devices.filter(
      (device) => device.kind === 'audioinput' && device.deviceId.length > 0,
    )
    // Chrome additionally lists "default" (and on Windows "communications")
    // aliases of physical mics — duplicates in a picker. Drop them whenever
    // the physical entries themselves are present.
    const physical = mics.filter(
      (device) => device.deviceId !== 'default' && device.deviceId !== 'communications',
    )
    const chooseFrom = physical.length > 0 ? physical : mics
    return chooseFrom.map((device) => ({ id: device.deviceId, label: device.label }))
  } catch {
    return []
  }
}

export function rememberedAudioInput(): RememberedAudioInput | null {
  try {
    const raw = localStorage.getItem(AUDIO_INPUT_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<RememberedAudioInput>
    if (typeof parsed.id !== 'string' || typeof parsed.label !== 'string') return null
    return { id: parsed.id, label: parsed.label }
  } catch {
    return null
  }
}

export function rememberAudioInput(option: AudioInputOption | null): void {
  try {
    if (option) localStorage.setItem(AUDIO_INPUT_STORAGE_KEY, JSON.stringify(option))
    else localStorage.removeItem(AUDIO_INPUT_STORAGE_KEY)
  } catch {
    // Storage unavailable (private mode) — the choice just won't persist.
  }
}

/**
 * The remembered mic resolved against a current enumeration: exact id when
 * still present, otherwise the same label (ids rotate on site-data clears),
 * otherwise nothing — the system default records the take. A remembered mic
 * that is merely unplugged right now stays remembered: reconnecting it (e.g.
 * a Bluetooth mic coming back) makes it win again, like OS audio routing.
 */
export function resolveAudioInput(inputs: AudioInputOption[]): string | undefined {
  const remembered = rememberedAudioInput()
  if (!remembered) return undefined
  if (inputs.some((input) => input.id === remembered.id)) return remembered.id
  if (remembered.label.length > 0) {
    const byLabel = inputs.find((input) => input.label === remembered.label)
    if (byLabel) return byLabel.id
  }
  return undefined
}

/** Enumerate-and-resolve for callers without a current device list. */
export async function resolvePreferredAudioInputId(): Promise<string | undefined> {
  if (!rememberedAudioInput()) return undefined
  return resolveAudioInput(await listAudioInputs())
}
