/** Accept string for the background-music file picker. */
export const AUDIO_FILE_ACCEPT = 'audio/*'

/** Songs, not albums: a soft cap that keeps IndexedDB quotas comfortable. */
const MAX_AUDIO_BYTES = 80 * 1024 * 1024

export interface ProbedAudioFile {
  blob: Blob
  mimeType: string
  durationMs: number
  name: string
}

/**
 * A picked file that can't be used as a background track (wrong type,
 * undecodable, too large). Expected user input — surfaced as guidance.
 */
export class AudioImportError extends Error {
  override readonly name = 'AudioImportError'
}

/**
 * Validate a picked audio file and measure its real duration by loading it
 * into an off-DOM audio element — the same engine that will play it back,
 * so "it probed" means "it will play".
 */
export async function probeAudioFile(file: File): Promise<ProbedAudioFile> {
  if (file.size === 0) {
    throw new AudioImportError('That file is empty')
  }
  if (file.size > MAX_AUDIO_BYTES) {
    throw new AudioImportError('That audio file is too large — pick one under 80 MB')
  }
  const mimeType = file.type || 'audio/mpeg'
  const durationMs = await probeAudioDuration(file, mimeType)
  if (durationMs < 500) {
    throw new AudioImportError('That audio file is too short to use as background music')
  }
  return {
    blob: file,
    mimeType,
    durationMs,
    name: file.name || 'Audio track',
  }
}

function probeAudioDuration(blob: Blob, mimeType: string, timeoutMs = 8000): Promise<number> {
  const typed = blob.type ? blob : new Blob([blob], { type: mimeType })
  const url = URL.createObjectURL(typed)
  const audio = new Audio()
  audio.preload = 'metadata'

  return new Promise<number>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      fail(new AudioImportError('Could not read that audio file'))
    }, timeoutMs)
    const cleanup = () => {
      window.clearTimeout(timer)
      audio.onloadedmetadata = null
      audio.ondurationchange = null
      audio.onerror = null
      audio.removeAttribute('src')
      audio.load()
      URL.revokeObjectURL(url)
    }
    const fail = (error: Error) => {
      cleanup()
      reject(error)
    }
    const tryResolve = () => {
      const seconds = audio.duration
      if (Number.isFinite(seconds) && seconds > 0) {
        cleanup()
        resolve(Math.round(seconds * 1000))
      }
    }
    audio.onloadedmetadata = tryResolve
    // Some encoders (VBR MP3s, streamed captures) only report a finite
    // duration on a later durationchange.
    audio.ondurationchange = tryResolve
    audio.onerror = () => {
      fail(new AudioImportError('That file could not be played — try an MP3, M4A, or WAV'))
    }
    audio.src = url
    audio.load()
  })
}
