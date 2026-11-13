/**
 * Proves a clip's file actually carries video. MediaRecorder happily muxes
 * an audio-only MP4 when the camera track stops delivering frames while the
 * mic keeps going, and duration probes (which count the audio track) accept
 * it. Such a clip plays as black and fails at export.
 */
export type ClipVideoProblem = 'no-video-track' | 'no-video-frames'

export const NO_VIDEO_RECORDING_MESSAGE = "That clip didn't record any video. Try again."

/** A finished take whose file has no video frames. Carries the take so
 * diagnostics can still describe it; the clip itself is never saved. */
export class NoVideoRecordingError extends Error {
  readonly problem: ClipVideoProblem
  readonly details: Record<string, unknown>
  constructor(problem: ClipVideoProblem, details: Record<string, unknown> = {}) {
    super(NO_VIDEO_RECORDING_MESSAGE)
    this.name = 'NoVideoRecordingError'
    this.problem = problem
    this.details = details
  }
}

/** `'unknown'` when the container could not be read (or not in time): an
 * unreadable or slow file is not proof of a missing track, and other paths
 * (duration probe, export) already handle undecodable media. */
export type ClipVideoProbe = ClipVideoProblem | 'ok' | 'unknown'

export interface ClipVideoProbeOptions {
  /** Start of the kept range. Frames before it (a warm encoder's pre-roll)
   * don't count: a take whose video stopped at the press is still blank. */
  keepFromMs?: number
  timeoutMs?: number
}

export async function probeClipVideo(
  blob: Blob,
  { keepFromMs = 0, timeoutMs = 8000 }: ClipVideoProbeOptions = {},
): Promise<ClipVideoProbe> {
  let timer = 0
  const timeout = new Promise<'unknown'>((resolve) => {
    timer = window.setTimeout(() => resolve('unknown'), timeoutMs)
  })
  try {
    return await Promise.race([readClipVideo(blob, keepFromMs), timeout])
  } finally {
    window.clearTimeout(timer)
  }
}

/** `null` when the file has video frames in its kept range, or could not
 * be read (see `ClipVideoProbe`). */
export async function findClipVideoProblem(
  blob: Blob,
  options?: ClipVideoProbeOptions,
): Promise<ClipVideoProblem | null> {
  const probe = await probeClipVideo(blob, options)
  return probe === 'ok' || probe === 'unknown' ? null : probe
}

async function readClipVideo(blob: Blob, keepFromMs: number): Promise<ClipVideoProbe> {
  if (blob.size === 0) return 'no-video-track'
  const { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } = await import('mediabunny')
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    // A file mediabunny cannot place at all says nothing about its tracks.
    if (!(await input.getFormat().catch(() => null))) return 'unknown'
    const tracks = await input.getTracks().catch(() => null)
    if (!tracks) return 'unknown'
    const video = tracks.find((track) => track.isVideoTrack())
    if (!video) return 'no-video-track'
    const first = await new EncodedPacketSink(video).getFirstPacket({ metadataOnly: true })
    if (!first) return 'no-video-frames'
    if (keepFromMs > 0) {
      const videoEndS = await video.computeDuration().catch(() => null)
      if (videoEndS !== null && videoEndS * 1000 <= keepFromMs) return 'no-video-frames'
    }
    return 'ok'
  } catch {
    return 'unknown'
  } finally {
    input.dispose()
  }
}
