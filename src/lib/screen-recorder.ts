/**
 * Screen recording as a clip source (a much-requested feature). Desktop-only
 * by platform reality: getDisplayMedia does not exist on iOS Safari or
 * Android browsers, so mobile users rely on their OS screen recorder instead.
 *
 * Captures the picked surface plus, when available, its audio and the
 * microphone (for narration) mixed into a single track. The result feeds the
 * exact same recorder + clip pipeline as camera takes.
 */

import { openMicrophoneTrack } from './media'
import { HoldRecorder, type RecordingResult } from './recorder'

export function isScreenRecordingSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
    typeof MediaRecorder !== 'undefined'
  )
}

export interface ScreenRecordingSession {
  /** Resolves with the finished take (null when too short). Idempotent. */
  stop(): Promise<RecordingResult | null>
  /**
   * Fires once when capture ends outside the app — the browser's own
   * "Stop sharing" control. The handler should call stop() to save.
   */
  setOnEnded(handler: () => void): void
}

/**
 * Prompts the surface picker and starts recording immediately.
 * Rejects with the picker's NotAllowedError when the user cancels.
 */
export async function startScreenRecording(): Promise<ScreenRecordingSession> {
  const display = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    // Tab/system audio when the user opts in via the picker; Firefox and
    // Safari simply return a video-only stream.
    audio: true,
  })
  const videoTrack = display.getVideoTracks()[0]
  if (!videoTrack) {
    display.getTracks().forEach((track) => track.stop())
    throw new Error('No screen video available')
  }

  // Narration mic — best effort. A denied mic must not kill the capture;
  // the take just records without narration (or with shared audio only).
  const micTrack = await openMicrophoneTrack().catch(() => null)

  const audioSources = [...display.getAudioTracks(), ...(micTrack ? [micTrack] : [])]
  let audioContext: AudioContext | null = null
  let audioTrack: MediaStreamTrack | null = null
  if (audioSources.length === 1) {
    audioTrack = audioSources[0]
  } else if (audioSources.length > 1) {
    // Shared audio + mic must merge into one track for MediaRecorder.
    audioContext = new AudioContext()
    void audioContext.resume().catch(() => undefined)
    const destination = audioContext.createMediaStreamDestination()
    for (const source of audioSources) {
      audioContext
        .createMediaStreamSource(new MediaStream([source]))
        .connect(destination)
    }
    audioTrack = destination.stream.getAudioTracks()[0] ?? null
  }

  const recordStream = new MediaStream([videoTrack, ...(audioTrack ? [audioTrack] : [])])
  const recorder = new HoldRecorder()

  const releaseTracks = () => {
    display.getTracks().forEach((track) => track.stop())
    micTrack?.stop()
    void audioContext?.close().catch(() => undefined)
  }

  if (!recorder.start(recordStream)) {
    releaseTracks()
    throw new Error('Could not start the screen recording')
  }

  let onEnded: (() => void) | null = null
  let endedFired = false
  videoTrack.addEventListener('ended', () => {
    if (endedFired) return
    endedFired = true
    onEnded?.()
  })

  let stopPromise: Promise<RecordingResult | null> | null = null
  return {
    stop() {
      // Both the in-app Stop button and the browser's "Stop sharing" ended
      // event can race here; the first caller owns the actual teardown.
      stopPromise ??= recorder.stop().finally(releaseTracks)
      return stopPromise
    },
    setOnEnded(handler) {
      onEnded = handler
    },
  }
}
