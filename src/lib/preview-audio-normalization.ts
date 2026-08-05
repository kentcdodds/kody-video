import { channelPeak, normalizationScale } from './export/background-audio'
import { decodeBlobAudio } from './export/shared'
import type { ClipMeta } from './types'

/**
 * The export peak-normalizes every audio source (the clip's own sound and
 * each playlist track) before applying its volume — a quietly mastered
 * song or a soft mic take is boosted up to 4×. For the live previews to
 * play at the levels (and hand tracks off at the positions) the export
 * will render, they need the same measurements. Clips carry theirs
 * persisted (`ClipMeta.audioPeak`, backfilled on project load); playlist
 * tracks are measured here with the export's own decode + exact peak
 * scan, cached per blob so a preview reopen never re-decodes.
 *
 * Levels are applied through plain element volumes, NOT a Web Audio
 * media-element graph: `createMediaElementSource` permanently captures an
 * element's output, and on WebKit/iOS a context that is not (yet) running
 * turns that into total silence with no way back. Element volume caps at
 * 1, so normalization boosts are clamped into the ceiling — the default
 * 25% track volume times the maximum 4× boost lands exactly at 1.0, and
 * louder settings play at the ceiling (slightly under the export's level,
 * but always audible everywhere).
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
/** Landed measurements, for synchronous (per-frame) reads. */
const resolved = new WeakMap<Blob, AudioNormalizationInfo>()

export function measureAudioNormalization(blob: Blob): Promise<AudioNormalizationInfo> {
  let pending = cache.get(blob)
  if (!pending) {
    pending = measure(blob).then((info) => {
      resolved.set(blob, info)
      return info
    })
    cache.set(blob, pending)
  }
  return pending
}

/** Synchronous view of a blob's measurement: the info once the decode has
 * landed, null (after kicking the decode off) until then. */
export function peekAudioNormalization(blob: Blob): AudioNormalizationInfo | null {
  const info = resolved.get(blob)
  if (info) return info
  void measureAudioNormalization(blob)
  return null
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

/** Element volume for one source at one moment: the export's normalized
 * level (gain × normalization boost), clamped to the volume ceiling. */
export function normalizedElementVolume(gain: number, scale: number): number {
  return Math.max(0, Math.min(1, gain * scale))
}

/** The clip's normalization gain: derived from the persisted measurement
 * when present (synchronous, export-exact), else from the in-memory
 * measurement while it lands (1 until then). */
export function clipAudioScale(clip: Pick<ClipMeta, 'audioPeak'> & { blob: Blob }): number {
  if (clip.audioPeak !== undefined) return normalizationScale(clip.audioPeak)
  return peekAudioNormalization(clip.blob)?.scale ?? 1
}
