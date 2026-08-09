import { channelPeak } from './export/background-audio'
import { decodeBlobAudio } from './export/shared'
import { updateClipAudioPeak } from './storage'
import { isImageClip, type ClipRecord } from './types'

/**
 * Post-recording audio normalization measurement: every clip's whole-file
 * audio peak is measured once and persisted on the clip record, so the
 * previews can apply the export's exact normalization gain synchronously
 * (no per-session decode wait) and every surface hears the same levels.
 * Runs automatically when a project loads with unmeasured clips — the
 * loader backfill, like thumbnails.
 */

/** Must match the export engines' mixing rate: peaks are measured AFTER
 * resampling, and resampling can nudge a waveform's peak. */
const PEAK_SAMPLE_RATE = 48000

/** The blob's exact whole-file audio peak; 0 = silent or undecodable
 * (normalizationScale treats both as "mix unscaled"). */
export async function measureClipAudioPeak(blob: Blob): Promise<number> {
  try {
    const buffer = await decodeBlobAudio(blob, PEAK_SAMPLE_RATE)
    if (!buffer) return 0
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, ch) =>
      buffer.getChannelData(ch),
    )
    return channelPeak(channels)
  } catch {
    return 0
  }
}

/** Measure and persist the clip's audio peak when it is still unmeasured.
 * Returns the (possibly updated) record for immediate use. Persistence is
 * best-effort: a write failure (quota, transient) must not fail the
 * project load — the measured value still serves this session, and the
 * next load retries the write. */
export async function ensureClipAudioPeak(clip: ClipRecord): Promise<ClipRecord> {
  if (clip.audioPeak !== undefined) return clip
  // Photos are silent by construction — persist the zero without wasting
  // an audio-decode attempt on image bytes.
  const audioPeak = isImageClip(clip) ? 0 : await measureClipAudioPeak(clip.blob)
  await updateClipAudioPeak(clip.id, audioPeak).catch(() => undefined)
  return { ...clip, audioPeak }
}
