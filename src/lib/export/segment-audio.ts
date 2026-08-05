/**
 * Clip-audio slicing for the WebCodecs export: one buffer per segment,
 * appended sequentially (timestamps are implied by position), with a short
 * equal-power CROSSFADE between adjacent clips instead of a dip to
 * silence. The old approach faded every slice edge to zero, which read as
 * a moment of silence at every joint; here the two neighbors overlap for
 * CROSSFADE_HALF_MS on each side of the cut — the outgoing clip's last
 * CROSSFADE_MS of audio fades out across the joint while the incoming
 * clip's first CROSSFADE_MS fades in, keeping the energy roughly constant.
 * To make room for the overlap, each clip gives up CROSSFADE_HALF_MS of
 * VIDEO at the joint (sub-frame at 30fps), so A/V stay sample-locked.
 *
 * Because buffers are appended in order, the overlap cannot span two
 * buffers: each segment WITHHOLDS its last CROSSFADE_MS of material as a
 * `carry`, and the next segment mixes that carry into its own first
 * CROSSFADE_MS. The withheld material always comes from inside the trim
 * window — nothing the user trimmed away is ever heard.
 */

/** Half the joint overlap: each neighbor contributes this much on its side
 * of the cut, and gives up this much video at the joint. The exporter's
 * fixed video chops rely on every emitted segment being longer than a full
 * crossfade — guaranteed because clampSegmentToMedia drops anything under
 * MIN_SEGMENT_MS (see plan.ts, and the invariant test in
 * segment-audio.test.ts). */
export const CROSSFADE_HALF_MS = 10
/** Full audio overlap at a joint. */
export const CROSSFADE_MS = CROSSFADE_HALF_MS * 2
/** Click-kill ramp at the film's outer edges and into silence padding —
 * long enough to kill clicks, far too short to hear. */
export const EDGE_FADE_MS = 3

function framesFor(ms: number, sampleRate: number): number {
  return Math.round((ms / 1000) * sampleRate)
}

export interface SegmentAudioArgs {
  /** Decoded clip audio, one array per source channel, or null when the
   * clip has no decodable audio (the slice stays silent). */
  source: readonly Float32Array[] | null
  /** Trim-in point within the source clip, in ms. */
  startMs: number
  /** The segment's real (clamped) duration, in ms. */
  segmentMs: number
  sampleRate: number
  channelCount: number
  /** Withheld tail of the previous emitted segment (null at the film start). */
  carryIn: Float32Array[] | null
  /** Whether another segment is planned after this one. */
  hasNext: boolean
}

export interface SegmentAudioSlice {
  /** Exactly this segment's share of the output audio timeline. */
  channels: Float32Array[]
  /** Withheld tail for the next joint's crossfade (null at the film end). */
  carryOut: Float32Array[] | null
}

/**
 * Build one segment's audio slice: the decoded clip audio at the trim-in
 * point, silence-padded where the clip has less audio than video, with the
 * previous segment's withheld tail crossfaded into the head and (when a
 * segment follows) the last CROSSFADE_MS withheld as the next carry.
 */
export function sliceSegmentAudio({
  source,
  startMs,
  segmentMs,
  sampleRate,
  channelCount,
  carryIn,
  hasNext,
}: SegmentAudioArgs): SegmentAudioSlice {
  const totalFrames = Math.max(1, framesFor(segmentMs, sampleRate))
  const overlapFrames = framesFor(CROSSFADE_MS, sampleRate)
  const withheldFrames = hasNext ? Math.min(overlapFrames, totalFrames - 1) : 0
  const length = totalFrames - withheldFrames
  const sourceStart = Math.floor((startMs / 1000) * sampleRate)
  const edgeFrames = framesFor(EDGE_FADE_MS, sampleRate)

  const channels: Float32Array[] = []
  let copiedFrames = 0
  for (let ch = 0; ch < channelCount; ch += 1) {
    const target = new Float32Array(length)
    channels.push(target)
    if (!source || source.length === 0) continue
    const data = source[Math.min(ch, source.length - 1)]!
    const available = Math.max(0, Math.min(length, data.length - sourceStart))
    for (let i = 0; i < available; i += 1) {
      target[i] = data[sourceStart + i]!
    }
    copiedFrames = Math.max(copiedFrames, available)
  }

  if (carryIn && carryIn.length > 0) {
    // Joint crossfade: equal-power so two uncorrelated recordings keep a
    // roughly constant loudness across the cut instead of dipping. The fade
    // completes within the available room even on degenerate tiny slices.
    const mixFrames = Math.min(overlapFrames, length, carryIn[0]!.length)
    for (let ch = 0; ch < channelCount; ch += 1) {
      const target = channels[ch]!
      const tail = carryIn[Math.min(ch, carryIn.length - 1)]!
      for (let i = 0; i < mixFrames; i += 1) {
        const theta = ((i + 0.5) / mixFrames) * (Math.PI / 2)
        target[i] = target[i]! * Math.sin(theta) + tail[i]! * Math.cos(theta)
      }
    }
  } else if (copiedFrames > 0) {
    // Film start: fade in from silence — a hard start mid-waveform clicks.
    const fade = Math.min(edgeFrames, Math.floor(copiedFrames / 2))
    for (let ch = 0; ch < channelCount; ch += 1) {
      const target = channels[ch]!
      for (let i = 0; i < fade; i += 1) {
        target[i]! *= i / fade
      }
    }
  }

  // Fade out where the copied material meets a HARD boundary: the film's
  // end, or silence padding when the clip's audio is shorter than its
  // video. A joint tail is NOT hard — it continues into the carry.
  if (copiedFrames > 0 && (copiedFrames < length || !hasNext)) {
    const fade = Math.min(edgeFrames, Math.floor(copiedFrames / 2))
    for (let ch = 0; ch < channelCount; ch += 1) {
      const target = channels[ch]!
      for (let i = 0; i < fade; i += 1) {
        target[copiedFrames - 1 - i]! *= i / fade
      }
    }
  }

  if (!hasNext) return { channels, carryOut: null }

  const carryOut: Float32Array[] = []
  let carryCopied = 0
  for (let ch = 0; ch < channelCount; ch += 1) {
    const tail = new Float32Array(overlapFrames)
    carryOut.push(tail)
    if (!source || source.length === 0) continue
    const data = source[Math.min(ch, source.length - 1)]!
    // Only material inside the segment's window is withheld — never read
    // past the trim-out point.
    const available = Math.max(
      0,
      Math.min(withheldFrames, data.length - (sourceStart + length)),
    )
    for (let i = 0; i < available; i += 1) {
      tail[i] = data[sourceStart + length + i]!
    }
    carryCopied = Math.max(carryCopied, available)
  }
  if (carryCopied > 0 && carryCopied < overlapFrames) {
    // The audio ran out mid-carry: kill the step to zero, which the joint
    // mix would otherwise play at high gain.
    const fade = Math.min(edgeFrames, carryCopied)
    for (const tail of carryOut) {
      for (let i = 0; i < fade; i += 1) {
        tail[carryCopied - 1 - i]! *= i / fade
      }
    }
  }
  return { channels, carryOut }
}

/**
 * When a withheld tail is left over after the last segment (every later
 * planned segment was dropped at encode time), emit its first
 * CROSSFADE_HALF_MS with a fade-out. That is exactly the slack the video
 * kept on that side of the never-realized joint, so the audio track ends
 * where the video does.
 */
export function flushCarry(carry: Float32Array[], sampleRate: number): Float32Array[] {
  const length = Math.max(1, framesFor(CROSSFADE_HALF_MS, sampleRate))
  return carry.map((tail) => {
    const target = new Float32Array(length)
    const available = Math.min(length, tail.length)
    for (let i = 0; i < available; i += 1) {
      target[i] = tail[i]! * (1 - (i + 1) / length)
    }
    return target
  })
}
