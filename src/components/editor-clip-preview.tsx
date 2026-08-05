import type { Handle } from 'remix/ui'
import { on, ref } from 'remix/ui'
import { planExport } from '../lib/export'
import {
  clipElementVolume,
  musicElementVolume,
  peekAudioNormalization,
} from '../lib/preview-audio-normalization'
import { BlobVideo } from './blob-video'
import { IconPause, IconPlay } from './icons'
import {
  clipAudioVolume,
  type ClipRecord,
  type ProjectAudioRecord,
  type ProjectAudioTrack,
} from '../lib/types'

export interface EditorClipPreviewHandle {
  seekToMs: (timeMs: number) => void
  pause: () => void
}

interface EditorClipPreviewProps {
  clip: ClipRecord
  /** All of the project's clips, in timeline order — the selected clip's
   * position on the OUTPUT timeline decides which part of the music
   * playlist plays under it. */
  clips: ClipRecord[]
  /** Background-music playlist (null when none / not unlocked). */
  audio: ProjectAudioRecord | null
  apiRef?: { current: EditorClipPreviewHandle | null }
}

function nudgeFrame(video: HTMLVideoElement): void {
  if (!video.paused || video.readyState < 2) return
  void video
    .play()
    .then(() => {
      video.pause()
    })
    .catch(() => undefined)
}

/**
 * Stage preview for the selected timeline clip.
 * Tap toggles playback within the trimmed range; expose seek for trim handles.
 * When the project has background music, the bed plays under the clip at the
 * level and playlist position the export will render for this clip.
 */
export function EditorClipPreview(handle: Handle<EditorClipPreviewProps>) {
  const { props } = handle
  let media: HTMLVideoElement | null = null
  let playing = false
  /** An explicit seek before loadeddata must not be snapped back to the trim
   * start when the metadata arrives. */
  let explicitSeek = false
  /** Latest scrub target (seconds) deferred while a seek is in flight.
   * Assigning currentTime mid-seek cancels the pending seek, so a fast trim
   * drag would paint no frames until the pointer rests; instead the newest
   * target waits for `seeked` and is applied then. */
  let pendingSeekSec: number | null = null

  // Music bed under the clip. Plain element volumes carry the export's
  // normalization scales (see preview-audio-normalization.ts) — the music
  // at share × scale, the clip's own sound at (1 − share) × its scale.
  let musicEl: HTMLAudioElement | null = null
  const trackUrls = new Map<number, string>()
  let musicTrackIndex = -1
  /** True when the playlist ran out before/at this clip's film position. */
  let musicExhausted = false

  // Segment plan cached per clips identity (same pattern as the overlay).
  let planFor: ClipRecord[] | null = null
  let segments: ReturnType<typeof planExport>['segments'] = []
  const resolveSegments = () => {
    if (planFor !== props.clips) {
      planFor = props.clips
      segments = planExport(props.clips).segments
    }
    return segments
  }

  /** The selected clip's planned segment (null when it gets dropped from
   * the export plan, e.g. a degenerate trim). */
  const ownSegment = () => resolveSegments().find((s) => s.clip.id === props.clip.id) ?? null

  /** Film (output-timeline) position for the current video time, clamped
   * into the clip's exported window — while trimming, the stage plays the
   * whole clip, including parts outside the trim that never export. */
  const filmPositionMs = (): number | null => {
    const segment = ownSegment()
    if (!segment) return null
    const videoMs = (media?.currentTime ?? 0) * 1000
    const elapsed = Math.max(0, Math.min(videoMs - segment.startMs, segment.endMs - segment.startMs))
    return segment.offsetMs + elapsed
  }

  const trackDurationMs = (track: ProjectAudioTrack): number =>
    peekAudioNormalization(track.blob)?.decodedDurationMs ?? track.durationMs

  /** Playlist track + in-track offset covering a film position (null when
   * the playlist has already run out there). */
  const trackAtMs = (positionMs: number): { index: number; offsetMs: number } | null => {
    const tracks = props.audio?.tracks ?? []
    let cursor = 0
    for (let i = 0; i < tracks.length; i += 1) {
      if (positionMs < cursor + trackDurationMs(tracks[i])) {
        return { index: i, offsetMs: positionMs - cursor }
      }
      cursor += trackDurationMs(tracks[i])
    }
    return null
  }

  const urlForTrack = (trackIndex: number): string => {
    let url = trackUrls.get(trackIndex)
    if (!url) {
      url = URL.createObjectURL(props.audio!.tracks[trackIndex].blob)
      trackUrls.set(trackIndex, url)
    }
    return url
  }

  /** This clip's music share of the mix (its override or the default). */
  const musicShare = (): number =>
    props.audio ? clipAudioVolume(props.clip, props.audio.defaultVolume) : 0

  /** Put the bed at the export-true position for the current video time and
   * start it (no-op when there is no music to play there). */
  const playMusic = () => {
    const audio = musicEl
    if (!audio || !props.audio) return
    const positionMs = filmPositionMs()
    const target = positionMs === null ? null : trackAtMs(positionMs)
    if (!target) {
      musicExhausted = true
      audio.pause()
      return
    }
    musicExhausted = false
    if (musicTrackIndex !== target.index) {
      musicTrackIndex = target.index
      audio.src = urlForTrack(target.index)
    }
    if (Math.abs(audio.currentTime - target.offsetMs / 1000) > 0.05) {
      audio.currentTime = target.offsetMs / 1000
    }
    void audio.play().catch(() => undefined)
  }

  const pauseMusic = () => {
    musicEl?.pause()
  }

  /** A track ran out mid-clip — hand off to the next one. */
  const advanceMusicTrack = () => {
    const tracks = props.audio?.tracks ?? []
    const audio = musicEl
    if (!audio) return
    const next = musicTrackIndex + 1
    if (next >= tracks.length) {
      musicExhausted = true
      return
    }
    musicTrackIndex = next
    audio.src = urlForTrack(next)
    audio.currentTime = 0
    if (media && !media.paused) void audio.play().catch(() => undefined)
  }

  const bindMusic = (el: HTMLAudioElement, signal: AbortSignal) => {
    musicEl = el
    // Kick the normalization measurements now so the levels are right by
    // the time playback starts (cached across previews and the overlay).
    for (const track of props.audio?.tracks ?? []) peekAudioNormalization(track.blob)
    peekAudioNormalization(props.clip.blob)

    // Per-frame level hold: constant share for one clip, but the measured
    // scales land asynchronously and the video element remounts on trim
    // changes — recomputing every frame keeps both sides correct.
    let raf = 0
    const tick = () => {
      const share = musicShare()
      const trackBlob = props.audio?.tracks[musicTrackIndex]?.blob
      const musicScale = trackBlob ? (peekAudioNormalization(trackBlob)?.scale ?? 1) : 1
      el.volume = musicElementVolume(share, musicScale)
      const video = media
      if (video) {
        const covered = !musicExhausted
        const clipScale = peekAudioNormalization(props.clip.blob)?.scale ?? 1
        // Where the playlist covers this clip the export blends the clip
        // at its normalized complement; where it doesn't, the clip's own
        // sound plays at its normalized full level.
        video.volume = covered ? clipElementVolume(share, clipScale) : Math.min(1, clipScale)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    signal.addEventListener('abort', () => {
      cancelAnimationFrame(raf)
      el.pause()
      if (musicEl === el) musicEl = null
      for (const url of trackUrls.values()) URL.revokeObjectURL(url)
      trackUrls.clear()
      musicTrackIndex = -1
    })
  }

  const setPlaying = (next: boolean) => {
    if (playing === next) return
    playing = next
    void handle.update()
  }

  const applySeek = (video: HTMLVideoElement, sec: number) => {
    if (video.seeking) {
      pendingSeekSec = sec
      return
    }
    pendingSeekSec = null
    if (Math.abs(video.currentTime - sec) > 0.02) {
      video.currentTime = sec
    } else {
      nudgeFrame(video)
    }
  }

  // Bound to the element's mount/unmount (not the first media event) so the
  // imperative handle works immediately — early pause()/seekToMs() calls on a
  // still-loading clip must act instead of silently no-oping (#58).
  const bindVideo = (video: HTMLVideoElement, signal: AbortSignal) => {
    media = video
    explicitSeek = false
    pendingSeekSec = null
    const apiRef = props.apiRef
    if (!apiRef) return
    apiRef.current = {
      seekToMs: (timeMs: number) => {
        const el = media
        if (!el) return
        explicitSeek = true
        el.pause()
        setPlaying(false)
        applySeek(el, Math.max(0, Math.min(timeMs, props.clip.durationMs)) / 1000)
      },
      pause: () => {
        const el = media
        if (!el) return
        el.pause()
        setPlaying(false)
      },
    }
    signal.addEventListener('abort', () => {
      // A remount (remountKey change) may bind the replacement element
      // before this abort runs — never null out the live binding.
      if (media !== video) return
      media = null
      apiRef.current = null
    })
  }

  const togglePlayback = () => {
    const video = media
    if (!video) return

    if (!video.paused) {
      video.pause()
      setPlaying(false)
      return
    }

    const startSec = props.clip.trimStartMs / 1000
    const endSec = props.clip.trimEndMs / 1000
    const atEnd = video.currentTime >= endSec - 0.04
    const beforeStart = video.currentTime < startSec - 0.04
    if (atEnd || beforeStart) {
      video.currentTime = startSec
    }
    // A stale scrub target must not yank playback once it starts.
    pendingSeekSec = null

    // Start the bed inside the same gesture — a promise continuation is too
    // late for WebKit's user-activation window.
    playMusic()
    void video
      .play()
      .then(() => setPlaying(true))
      .catch(() => {
        pauseMusic()
        setPlaying(false)
      })
  }

  return () => {
    const clip = props.clip
    const startSec = clip.trimStartMs / 1000
    const endSec = clip.trimEndMs / 1000
    const remountKey = `${clip.id}:${clip.blob.size}:${clip.blob.type}:${clip.trimStartMs}:${clip.trimEndMs}`
    const hasMusic = (props.audio?.tracks.length ?? 0) > 0

    return (
      <div className="editor-clip-preview-wrap">
        {hasMusic ? (
          <audio
            preload="auto"
            aria-hidden="true"
            mix={[
              ref((node, signal) => bindMusic(node as HTMLAudioElement, signal)),
              on('ended', () => advanceMusicTrack()),
            ]}
          />
        ) : null}
        <BlobVideo
          key={remountKey}
          blob={clip.blob}
          videoRef={bindVideo}
          className="editor-clip-preview"
          playsInline
          preload="auto"
          mix={[
            on('loadeddata', (event) => {
              const video = event.currentTarget as HTMLVideoElement
              // Don't clobber a seek the user already made while loading.
              if (explicitSeek) return
              if (Math.abs(video.currentTime - startSec) > 0.04) {
                video.currentTime = startSec
                return
              }
              nudgeFrame(video)
            }),
            on('seeked', (event) => {
              const video = event.currentTarget as HTMLVideoElement
              if (pendingSeekSec !== null) {
                const sec = pendingSeekSec
                pendingSeekSec = null
                if (Math.abs(video.currentTime - sec) > 0.02) {
                  video.currentTime = sec
                  return
                }
              }
              if (video.paused) nudgeFrame(video)
            }),
            on('timeupdate', (event) => {
              const video = event.currentTarget as HTMLVideoElement
              if (!video.paused && video.currentTime >= endSec - 0.02) {
                video.pause()
                video.currentTime = endSec
                setPlaying(false)
              }
            }),
            // Every pause path (tap, trim-end stop, imperative pause, the
            // OS backgrounding the tab) silences the bed. Starting it stays
            // on the explicit toggle path only — nudgeFrame's play/pause
            // frame-paint dance also fires 'play', and hooking the bed
            // there would blip the music on every scrub.
            on('pause', () => {
              pauseMusic()
              setPlaying(false)
            }),
            on('play', () => setPlaying(true)),
            on('click', togglePlayback),
          ]}
        />
        <button
          type="button"
          className="editor-preview-affordance"
          aria-label={playing ? 'Pause clip preview' : 'Play clip preview'}
          mix={on('click', togglePlayback)}
        >
          {playing ? <IconPause size={18} /> : <IconPlay size={18} />}
        </button>
      </div>
    )
  }
}
