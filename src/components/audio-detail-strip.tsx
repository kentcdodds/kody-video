import type { Handle } from 'remix/ui'
import { on, ref } from 'remix/ui'
import { decodeBlobAudio } from '../lib/export/shared'
import {
  formatDuration,
  resolveAudioTrackPlayback,
  type ProjectAudioRecord,
  type ProjectAudioTrack,
} from '../lib/types'
import { IconMusic, IconPause, IconPlay } from './icons'

const MIN_GAP_MS = 100
/** Waveform resolution: enough bars to read the song's shape in the strip. */
const WAVEFORM_BINS = 120
/** Decode rate for the waveform — it shapes pixels, not audio. */
const WAVEFORM_SAMPLE_RATE = 8000

/** Per-track playback settings the detail view edits, saved on Done. */
export interface AudioTrackDraft {
  trimStartMs: number
  trimEndMs: number
  volume: number
  fadeIn: boolean
  fadeOut: boolean
}

interface AudioDetailStripProps {
  track: ProjectAudioTrack
  /** Playlist record — fade defaults for tracks without their own flags. */
  playlist: ProjectAudioRecord
  trackIndex: number
  onDone: (draft: AudioTrackDraft) => Promise<void>
  onCancel: () => void
}

/**
 * Detail view for ONE background-music track, opened from its playlist row
 * — the audio counterpart of the clip TrimStrip. Trim handles bound the
 * kept window over a waveform, the level slider scales the track's side of
 * the mix, and the fade toggles ease the track in/out where it starts and
 * ends. Everything is a local draft until Done persists it (Cancel or
 * Escape discards); the preview button auditions the kept window live.
 */
export function AudioDetailStrip(handle: Handle<AudioDetailStripProps>) {
  const { props } = handle
  const initial = resolveAudioTrackPlayback(props.track, props.playlist)
  let startMs = initial.trimStartMs
  let endMs = Math.min(initial.trimEndMs, props.track.durationMs)
  let volume = initial.volume
  let fadeIn = initial.fadeIn
  let fadeOut = initial.fadeOut
  let saving = false
  let error: string | null = null
  let activeHandle: 'start' | 'end' | null = null
  let auditioning = false

  const duration = () => Math.max(1, props.track.durationMs)

  // Waveform peaks (0–1 per bin), decoded once in the background.
  let peaks: Float32Array | null = null
  const canvasRef: { current: HTMLCanvasElement | null } = { current: null }
  const auditionRef: { current: HTMLAudioElement | null } = { current: null }
  const auditionUrl = URL.createObjectURL(props.track.blob)

  void (async () => {
    const buffer = await decodeBlobAudio(props.track.blob, WAVEFORM_SAMPLE_RATE).catch(
      () => null,
    )
    if (!buffer || buffer.length === 0) return
    const data = buffer.getChannelData(0)
    const bins = new Float32Array(WAVEFORM_BINS)
    const binLength = data.length / WAVEFORM_BINS
    for (let bin = 0; bin < WAVEFORM_BINS; bin += 1) {
      const from = Math.floor(bin * binLength)
      const to = Math.min(data.length, Math.max(from + 1, Math.ceil((bin + 1) * binLength)))
      let peak = 0
      // Strided scan is fine here — this shapes pixels, not gain.
      const step = Math.max(1, Math.floor((to - from) / 64))
      for (let i = from; i < to; i += step) {
        const value = Math.abs(data[i])
        if (value > peak) peak = value
      }
      bins[bin] = peak
    }
    const max = bins.reduce((a, b) => Math.max(a, b), 0)
    if (max > 0) {
      for (let i = 0; i < bins.length; i += 1) bins[i] /= max
    }
    peaks = bins
    drawWaveform()
  })()

  function drawWaveform() {
    const canvas = canvasRef.current
    if (!canvas || !peaks) return
    const dpr = window.devicePixelRatio || 1
    const width = canvas.clientWidth || 300
    const height = canvas.clientHeight || 64
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)'
    const barWidth = Math.max(1, width / peaks.length - 1)
    for (let i = 0; i < peaks.length; i += 1) {
      const x = (i / peaks.length) * width
      const barHeight = Math.max(2, peaks[i] * (height - 8))
      ctx.fillRect(x, (height - barHeight) / 2, barWidth, barHeight)
    }
  }

  const msFromClientX = (clientX: number, strip: HTMLElement) => {
    const rect = strip.getBoundingClientRect()
    if (rect.width <= 0) return 0
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return Math.round(ratio * duration())
  }

  const seekAudition = (ms: number) => {
    const el = auditionRef.current
    if (el) el.currentTime = ms / 1000
  }

  const stopAudition = () => {
    auditionRef.current?.pause()
  }

  const toggleAudition = () => {
    const el = auditionRef.current
    if (!el) return
    if (!el.paused) {
      el.pause()
      return
    }
    // Start inside the kept window (from its start when outside it).
    const positionMs = el.currentTime * 1000
    if (positionMs < startMs || positionMs >= endMs - MIN_GAP_MS / 2) {
      el.currentTime = startMs / 1000
    }
    el.volume = volume
    void el.play().catch(() => undefined)
  }

  const startHandleDrag = (which: 'start' | 'end', event: PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const dragHandle = event.currentTarget as HTMLButtonElement
    const strip = dragHandle.closest('.trim-strip-track') as HTMLElement | null
    if (!strip) return

    dragHandle.setPointerCapture(event.pointerId)
    activeHandle = which
    void handle.update()

    const onMove = (ev: PointerEvent) => {
      const next = msFromClientX(ev.clientX, strip)
      if (which === 'start') {
        startMs = Math.max(0, Math.min(next, endMs - MIN_GAP_MS))
        seekAudition(startMs)
      } else {
        endMs = Math.min(duration(), Math.max(next, startMs + MIN_GAP_MS))
        seekAudition(endMs)
      }
      void handle.update()
    }

    const onUp = (ev: PointerEvent) => {
      try {
        dragHandle.releasePointerCapture(ev.pointerId)
      } catch {
        /* already released */
      }
      dragHandle.removeEventListener('pointermove', onMove)
      dragHandle.removeEventListener('pointerup', onUp)
      dragHandle.removeEventListener('pointercancel', onUp)
      activeHandle = null
      void handle.update()
    }

    dragHandle.addEventListener('pointermove', onMove)
    dragHandle.addEventListener('pointerup', onUp)
    dragHandle.addEventListener('pointercancel', onUp)

    seekAudition(which === 'start' ? startMs : endMs)
  }

  const onDoneClick = () => {
    void (async () => {
      if (!(endMs > startMs)) {
        error = 'End must be after start.'
        void handle.update()
        return
      }
      saving = true
      error = null
      stopAudition()
      void handle.update()
      try {
        await props.onDone({
          trimStartMs: Math.round(startMs),
          trimEndMs: Math.round(endMs),
          volume,
          fadeIn,
          fadeOut,
        })
      } catch (err) {
        error = err instanceof Error ? err.message : 'Could not save the track settings'
        saving = false
        void handle.update()
      }
    })()
  }

  return () => {
    const { track, trackIndex } = props
    const keptMs = Math.max(0, endMs - startMs)
    const startPct = (startMs / duration()) * 100
    const endPct = (endMs / duration()) * 100
    const levelPct = Math.round(volume * 100)

    return (
      <div
        className="audio-detail-strip"
        role="group"
        aria-label={`Music track ${trackIndex + 1} settings`}
        mix={ref((_node, signal) => {
          signal.addEventListener('abort', () => {
            auditionRef.current?.pause()
            URL.revokeObjectURL(auditionUrl)
          })
        })}
      >
        <audio
          src={auditionUrl}
          preload="auto"
          aria-hidden="true"
          mix={[
            ref((node, signal) => {
              auditionRef.current = node as HTMLAudioElement
              signal.addEventListener('abort', () => {
                if (auditionRef.current === node) auditionRef.current = null
              })
            }),
            on('play', () => {
              auditioning = true
              void handle.update()
            }),
            on('pause', () => {
              auditioning = false
              void handle.update()
            }),
            on('timeupdate', (event) => {
              const el = event.currentTarget as HTMLAudioElement
              // The audition plays the kept window only.
              if (el.currentTime * 1000 >= endMs) el.pause()
            }),
          ]}
        />

        <div className="trim-strip-meta">
          <span className="audio-detail-name" title={track.name}>
            <IconMusic size={14} />
            {track.name}
          </span>
          <span className="trim-kept-label">{formatDuration(keptMs)} kept</span>
          {error ? <span className="trim-error">{error}</span> : null}
        </div>

        <div className="trim-strip-track audio-detail-track">
          <canvas
            className="audio-detail-wave"
            aria-hidden="true"
            mix={ref((node, signal) => {
              canvasRef.current = node as HTMLCanvasElement
              drawWaveform()
              signal.addEventListener('abort', () => {
                if (canvasRef.current === node) canvasRef.current = null
              })
            })}
          />

          <div className="trim-dim trim-dim-left" style={{ width: `${startPct}%` }} aria-hidden />
          <div
            className="trim-dim trim-dim-right"
            style={{ width: `${100 - endPct}%` }}
            aria-hidden
          />

          <div
            className="trim-selection"
            style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
            aria-hidden
          />

          <button
            type="button"
            className={`trim-handle trim-handle-left${activeHandle === 'start' ? ' active' : ''}`}
            style={{ left: `${startPct}%` }}
            aria-label="Trim music start"
            mix={on('pointerdown', (event) => startHandleDrag('start', event))}
          />
          <button
            type="button"
            className={`trim-handle trim-handle-right${activeHandle === 'end' ? ' active' : ''}`}
            style={{ left: `${endPct}%` }}
            aria-label="Trim music end"
            mix={on('pointerdown', (event) => startHandleDrag('end', event))}
          />
        </div>

        <div className="audio-detail-controls">
          <button
            type="button"
            className="btn btn-ghost audio-detail-audition"
            aria-label={auditioning ? 'Pause the music preview' : 'Preview the kept music'}
            mix={on('click', () => toggleAudition())}
          >
            {auditioning ? <IconPause size={16} /> : <IconPlay size={16} />}
            Preview
          </button>
          <div className="audio-detail-level">
            <span className="audio-volume-label">Level</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={levelPct}
              aria-label="Track level"
              aria-valuetext={`${levelPct}% level`}
              mix={[
                on('input', (event) => {
                  volume = Number((event.currentTarget as HTMLInputElement).value) / 100
                  const el = auditionRef.current
                  if (el) el.volume = volume
                  void handle.update()
                }),
              ]}
            />
            <strong className="audio-detail-level-value">{levelPct}%</strong>
          </div>
          <span className="audio-fades" role="group" aria-label="Track fades">
            <label className="audio-fade-toggle">
              <input
                type="checkbox"
                checked={fadeIn}
                aria-label="Fade this track in"
                mix={on('change', (event) => {
                  fadeIn = (event.currentTarget as HTMLInputElement).checked
                  void handle.update()
                })}
              />
              Fade in
            </label>
            <label className="audio-fade-toggle">
              <input
                type="checkbox"
                checked={fadeOut}
                aria-label="Fade this track out"
                mix={on('change', (event) => {
                  fadeOut = (event.currentTarget as HTMLInputElement).checked
                  void handle.update()
                })}
              />
              Fade out
            </label>
          </span>
        </div>

        <div className="trim-strip-actions">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={saving}
            mix={on('click', () => {
              stopAudition()
              props.onCancel()
            })}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving}
            mix={on('click', onDoneClick)}
          >
            {saving ? 'Saving…' : 'Done'}
          </button>
        </div>
      </div>
    )
  }
}
