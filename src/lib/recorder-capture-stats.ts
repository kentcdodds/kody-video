import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from 'mediabunny'

/** Frame-spacing stats for a recorded blob — used to A/B capture paths. */
export interface CaptureStats {
  frameCount: number
  durationMs: number
  meanIntervalMs: number
  maxGapMs: number
  /** Intervals longer than 1.8× the expected frame time. */
  largeGapCount: number
  expectedFps: number
  achievedFps: number
}

/**
 * Demux video packet timestamps (no decode). A janky take shows up as
 * fewer packets than wall-clock × fps and/or large timestamp gaps.
 */
export async function measureRecordedVideo(
  blob: Blob,
  expectedFps = 30,
): Promise<CaptureStats> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const track = await input.getPrimaryVideoTrack()
  if (!track) {
    return {
      frameCount: 0,
      durationMs: 0,
      meanIntervalMs: 0,
      maxGapMs: 0,
      largeGapCount: 0,
      expectedFps,
      achievedFps: 0,
    }
  }
  const sink = new EncodedPacketSink(track)
  const timestamps: number[] = []
  let packet = await sink.getFirstPacket()
  while (packet) {
    timestamps.push(packet.timestamp)
    packet = await sink.getNextPacket(packet)
  }
  const durationMs = timestamps.length > 0 ? Math.round((timestamps[timestamps.length - 1] ?? 0) * 1000) : 0
  const intervals: number[] = []
  for (let i = 1; i < timestamps.length; i += 1) {
    intervals.push((timestamps[i]! - timestamps[i - 1]!) * 1000)
  }
  const meanIntervalMs =
    intervals.length > 0 ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length : 0
  const maxGapMs = intervals.length > 0 ? Math.max(...intervals) : 0
  const expectedIntervalMs = 1000 / expectedFps
  const largeGapCount = intervals.filter((interval) => interval > expectedIntervalMs * 1.8).length
  const achievedFps = durationMs > 0 ? (timestamps.length / durationMs) * 1000 : 0
  return {
    frameCount: timestamps.length,
    durationMs,
    meanIntervalMs,
    maxGapMs,
    largeGapCount,
    expectedFps,
    achievedFps,
  }
}
