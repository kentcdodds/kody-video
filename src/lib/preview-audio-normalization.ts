import { channelPeak, normalizationScale } from './export/background-audio'
import { decodeBlobAudio } from './export/shared'

/**
 * The export peak-normalizes both sides of the background-music mix (the
 * clip's own sound and each playlist track) before blending them by the
 * mix share — a quietly mastered song is boosted up to 4×. For the live
 * preview to play the music at the level (and hand tracks off at the
 * position) the export will render, it needs the same measurements: this
 * module runs the export's own decode + exact peak scan per source blob,
 * cached so a preview reopen or playlist revisit never re-decodes.
 */

export interface AudioNormalizationInfo {
  /** Gain the export applies to this source before blending. */
  scale: number
  /** Decoded audio length in ms — where the export actually hands off to
   * the next playlist track (null when the blob has no decodable audio). */
  decodedDurationMs: number | null
}

/** Must match the export engines' mixing rate: the export computes peaks
 * AFTER resampling, and resampling can nudge a waveform's peak. */
const EXPORT_SAMPLE_RATE = 48000

const cache = new WeakMap<Blob, Promise<AudioNormalizationInfo>>()

export function measureAudioNormalization(blob: Blob): Promise<AudioNormalizationInfo> {
  let pending = cache.get(blob)
  if (!pending) {
    pending = measure(blob)
    cache.set(blob, pending)
  }
  return pending
}

async function measure(blob: Blob): Promise<AudioNormalizationInfo> {
  try {
    const buffer = await decodeBlobAudio(blob, EXPORT_SAMPLE_RATE)
    if (!buffer) return { scale: 1, decodedDurationMs: null }
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, ch) =>
      buffer.getChannelData(ch),
    )
    return {
      scale: normalizationScale(channelPeak(channels)),
      decodedDurationMs: Math.round(buffer.duration * 1000),
    }
  } catch {
    // Same stance as the export: an undecodable source is mixed unscaled.
    return { scale: 1, decodedDurationMs: null }
  }
}
