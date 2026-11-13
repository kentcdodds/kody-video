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

/**
 * `null` when the file has a video track with at least one frame, or when
 * the container could not be read in time: an unreadable or slow file is
 * not proof of a missing track, and other paths (duration probe, export)
 * already handle undecodable media.
 */
export async function findClipVideoProblem(
  blob: Blob,
  timeoutMs = 8000,
): Promise<ClipVideoProblem | null> {
  let timer = 0
  const timeout = new Promise<null>((resolve) => {
    timer = window.setTimeout(() => resolve(null), timeoutMs)
  })
  try {
    return await Promise.race([readClipVideoProblem(blob), timeout])
  } finally {
    window.clearTimeout(timer)
  }
}

async function readClipVideoProblem(blob: Blob): Promise<ClipVideoProblem | null> {
  if (blob.size === 0) return 'no-video-track'
  const { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } = await import('mediabunny')
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    // A file mediabunny cannot place at all says nothing about its tracks.
    if (!(await input.getFormat().catch(() => null))) return null
    const tracks = await input.getTracks().catch(() => null)
    if (!tracks) return null
    const video = tracks.find((track) => track.isVideoTrack())
    if (!video) return 'no-video-track'
    const first = await new EncodedPacketSink(video).getFirstPacket({ metadataOnly: true })
    return first ? null : 'no-video-frames'
  } catch {
    return null
  } finally {
    input.dispose()
  }
}
