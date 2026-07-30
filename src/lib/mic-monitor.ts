/**
 * Live mic-level watch during a take. Sentry showed exports whose source
 * clips peak at ~0.002 — the mic recorded nothing and the user only found
 * out after sharing. This surfaces that while they're still recording.
 */

/** Same near-silence floor the export diagnostics use (see export/shared). */
const SILENT_PEAK = 0.005
/** Give the mic time to warm up before calling it silent. */
const GRACE_MS = 2500
const SAMPLE_INTERVAL_MS = 300

export interface MicLevelMonitor {
  stop(): void
}

/**
 * Watches the stream's audio track through an AnalyserNode (a passive extra
 * consumer — MediaRecorder is unaffected). Calls onSilent when the take has
 * gone a full grace period without any signal above the floor — whether from
 * the start or because the mic died mid-take — and onSound whenever signal
 * (re)appears. Best-effort: any Web Audio failure just means no warning.
 */
export function startMicLevelMonitor(
  stream: MediaStream,
  handlers: { onSilent: () => void; onSound: () => void },
): MicLevelMonitor {
  const track = stream.getAudioTracks().find((t) => t.readyState === 'live')
  if (!track || typeof AudioContext === 'undefined') {
    return { stop: () => undefined }
  }

  let context: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let timer = 0
  let startedAt = 0

  const stop = () => {
    window.clearInterval(timer)
    timer = 0
    try {
      analyser?.disconnect()
    } catch {
      // Already torn down.
    }
    void context?.close().catch(() => undefined)
    context = null
    analyser = null
  }

  try {
    context = new AudioContext()
    void context.resume().catch(() => undefined)
    // A dedicated audio-only stream keeps Safari's MediaStreamSource happy.
    const source = context.createMediaStreamSource(new MediaStream([track]))
    analyser = context.createAnalyser()
    analyser.fftSize = 2048
    source.connect(analyser)
  } catch {
    stop()
    return { stop: () => undefined }
  }

  const samples = new Float32Array(analyser.fftSize)
  /** When signal was last heard; silence is judged on a rolling window so a
   * mic dying mid-take gets flagged too, not just one that was dead at the
   * start. */
  let lastSoundAt: number | null = null
  let verdict: 'pending' | 'silent' | 'sound' = 'pending'
  startedAt = performance.now()

  timer = window.setInterval(() => {
    if (!analyser) return
    // A suspended context reads all-zero — indistinguishable from a dead
    // mic (which, unlike a muted TRACK, is not a condition to warn about).
    // Never judge silence unless audio is actually flowing.
    if (context?.state !== 'running') {
      void context?.resume().catch(() => undefined)
      startedAt = performance.now()
      return
    }
    try {
      analyser.getFloatTimeDomainData(samples)
    } catch {
      stop()
      return
    }
    let tickPeak = 0
    for (let i = 0; i < samples.length; i += 4) {
      const value = Math.abs(samples[i]!)
      if (value > tickPeak) tickPeak = value
    }
    const now = performance.now()
    if (tickPeak >= SILENT_PEAK) {
      lastSoundAt = now
      // Signal clears immediately — including a warning a previous take set.
      if (verdict !== 'sound') {
        verdict = 'sound'
        handlers.onSound()
      }
      return
    }
    if (now - (lastSoundAt ?? startedAt) < GRACE_MS) return
    if (verdict !== 'silent') {
      verdict = 'silent'
      handlers.onSilent()
    }
  }, SAMPLE_INTERVAL_MS)

  return { stop }
}
