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
 * One shared AudioContext for all takes, suspended between them. Creating
 * and closing a context around every take churns the platform audio graph
 * while MediaRecorder still owns the tracks — observed on Android as the
 * camera preview flashing black right after a take ends.
 */
let sharedContext: AudioContext | null = null

function acquireContext(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null
  try {
    sharedContext ??= new AudioContext()
    void sharedContext.resume().catch(() => undefined)
    return sharedContext
  } catch {
    return null
  }
}

/**
 * Create the shared AudioContext ahead of the first take. Constructing a
 * context spins up the platform audio stack — doing it inside the
 * pointerdown that starts the first recording is a first-take-only stutter.
 * Called from an idle moment on the record screen; created suspended so an
 * idle preview never keeps the audio graph running.
 */
export function warmMicMonitorContext(): void {
  if (sharedContext || typeof AudioContext === 'undefined') return
  try {
    sharedContext = new AudioContext()
    void sharedContext.suspend().catch(() => undefined)
  } catch {
    // Leave it to acquireContext to retry per take.
  }
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
  const context = track ? acquireContext() : null
  if (!track || !context) {
    return { stop: () => undefined }
  }

  let source: MediaStreamAudioSourceNode | null = null
  let analyser: AnalyserNode | null = null
  let timer = 0
  let startedAt = 0

  const stop = () => {
    window.clearInterval(timer)
    timer = 0
    try {
      source?.disconnect()
      analyser?.disconnect()
    } catch {
      // Already torn down.
    }
    source = null
    analyser = null
    // Suspend (never close) the shared context — see acquireContext.
    void sharedContext?.suspend().catch(() => undefined)
  }

  try {
    // A dedicated audio-only stream keeps Safari's MediaStreamSource happy.
    source = context.createMediaStreamSource(new MediaStream([track]))
    analyser = context.createAnalyser()
    analyser.fftSize = 2048
    source.connect(analyser)
  } catch {
    stop()
    return { stop: () => undefined }
  }

  // A released mic reads all-zero — a leaked monitor sampling a dead track
  // must never fire a false "mic silent" warning.
  track.addEventListener('ended', stop)

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
      // Restart the rolling window entirely: a stale lastSoundAt from before
      // the suspension would otherwise flag silence instantly on resume.
      startedAt = performance.now()
      lastSoundAt = null
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
