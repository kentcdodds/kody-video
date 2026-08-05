import type { Handle } from 'remix/ui'
import { on, ref } from 'remix/ui'
import { planExport } from '../lib/export'
import {
  clipAudioScale,
  measureAudioNormalization,
  normalizedElementVolume,
  peekAudioNormalization,
} from '../lib/preview-audio-normalization'
import {
  playlistFadeInScale,
  playlistFadeOutScale,
  playlistTrackAtMs,
  trackKeptDurationMs,
  trackMediaSec,
  trackMusicGain,
} from '../lib/preview-music-bed'
import { BlobVideo } from './blob-video'
import { IconPause, IconPlay } from './icons'
import {
  clipMusicVolume,
  clipSoundVolume,
  type ClipRecord,
  type ProjectAudioRecord,
} from '../lib/types'

/** Smoothing time constant for level moves (~settles in 3×) — matches the
 * project preview's glide feel. */
const MIX_GLIDE_TAU_MS = 200

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
  // at its clip-scaled volume × scale, the clip's own sound at its own
  // volume × its scale (the two are independent).
  let musicEl: HTMLAudioElement | null = null
  /** Object URLs keyed by track BLOB — the stage outlives playlist edits
   * (it is keyed by clip id), so index-keyed URLs would go stale when a
   * track is removed or reordered. */
  const trackUrls = new Map<Blob, string>()
  let musicTrackIndex = -1
  /** True when the playlist ran out before/at this clip's film position. */
  let musicExhausted = false
  /** The playlist record the bed state belongs to — an edit (add / remove /
   * reorder / new load) swaps the record identity and invalidates the
   * loaded track index. */
  let audioFor: ProjectAudioRecord | null = null

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
   * whole clip, including parts outside the trim that never export. The
   * mapping always follows the SAVED trims (the plan the export would
   * render right now); draft handle positions only exist inside TrimStrip
   * until Done commits them, and threading them through here would remount
   * the stage video on every drag. */
  const filmPositionMs = (): number | null => {
    const segment = ownSegment()
    if (!segment) return null
    const videoMs = (media?.currentTime ?? 0) * 1000
    const elapsed = Math.max(0, Math.min(videoMs - segment.startMs, segment.endMs - segment.startMs))
    return segment.offsetMs + elapsed
  }

  const filmTotalMs = (): number => {
    const segs = resolveSegments()
    const last = segs[segs.length - 1]
    return last ? last.offsetMs + (last.endMs - last.startMs) : 0
  }

  /** The export's film-edge fade envelope at a film position — the
   * first/last clips must sound like the exported film, not open at full
   * level. Per-track (interior) fades ride trackMusicGain instead. */
  const fadeScaleAt = (positionMs: number): number => {
    const audio = props.audio
    if (!audio) return 1
    return Math.min(
      playlistFadeInScale(audio, positionMs),
      playlistFadeOutScale(audio, positionMs, filmTotalMs()),
    )
  }

  /** Playlist track + in-track KEPT-window offset covering a film position
   * (null when the playlist has already run out there). */
  const trackAtMs = (positionMs: number): { index: number; offsetMs: number } | null =>
    props.audio ? playlistTrackAtMs(props.audio, positionMs) : null

  const urlForTrack = (trackIndex: number): string => {
    const blob = props.audio!.tracks[trackIndex].blob
    let url = trackUrls.get(blob)
    if (!url) {
      url = URL.createObjectURL(blob)
      trackUrls.set(blob, url)
    }
    return url
  }

  /** The playlist changed under a mounted stage — drop every cached URL and
   * the loaded-track state, then realign the bed if it should be playing. */
  const resetMusicForPlaylistChange = () => {
    for (const url of trackUrls.values()) URL.revokeObjectURL(url)
    trackUrls.clear()
    musicTrackIndex = -1
    musicExhausted = false
    const audio = musicEl
    if (!audio) return
    const wasAudible = media !== null && !media.paused
    audio.pause()
    audio.removeAttribute('src')
    if (wasAudible) playMusic()
  }

  /** The music's level while this clip plays (its duck, if any). */
  const musicLevel = (): number => (props.audio ? clipMusicVolume(props.clip) : 0)

  /** The clip's own element volume: its sound level × normalization. */
  const clipElementVolumeNow = (): number =>
    normalizedElementVolume(clipSoundVolume(props.clip), clipAudioScale(props.clip))

  /** Without music there is no per-frame tick — apply the clip's own
   * level (and normalization) directly whenever it may have changed. The
   * gate matches the music element's mount condition (tracks present):
   * only a MOUNTED bed runs the tick that owns the volume instead. */
  const applyClipVolume = () => {
    const video = media
    if (!video || (props.audio?.tracks.length ?? 0) > 0) return
    video.volume = clipElementVolumeNow()
  }

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
    // offsetMs is inside the KEPT window — media time adds the trim.
    const expectedSec = trackMediaSec(props.audio, target.index, target.offsetMs)
    // Positions inside a finished track's metadata overshoot have no
    // decoded audio behind them — playing there would RESTART the ended
    // element (play() on an ended media element seeks back to 0).
    const decodedEndSec = Number.isFinite(audio.duration) ? audio.duration : Infinity
    if (musicExhausted && musicTrackIndex === target.index && expectedSec >= decodedEndSec - 0.05) {
      return
    }
    musicExhausted = false
    if (musicTrackIndex !== target.index) {
      musicTrackIndex = target.index
      audio.src = urlForTrack(target.index)
    }
    if (Math.abs(audio.currentTime - expectedSec) > 0.05) {
      audio.currentTime = expectedSec
    }
    void audio.play().catch(() => undefined)
  }

  const pauseMusic = () => {
    musicEl?.pause()
  }

  /** A landed measurement can move the playlist's boundaries (decoded
   * lengths replace metadata durations) — realign a PLAYING bed to the
   * corrected, export-true position. Small in-track drift is left alone,
   * same stance as the project preview, so accurate metadata re-seeks
   * nothing. */
  const resyncMusicIfPlaying = () => {
    const audio = musicEl
    if (!audio || audio.paused) return
    const positionMs = filmPositionMs()
    const target = positionMs === null ? null : trackAtMs(positionMs)
    if (!target) {
      musicExhausted = true
      audio.pause()
      return
    }
    musicExhausted = false
    const expectedSec = trackMediaSec(props.audio!, target.index, target.offsetMs)
    if (musicTrackIndex !== target.index) {
      musicTrackIndex = target.index
      audio.src = urlForTrack(target.index)
      audio.currentTime = expectedSec
      void audio.play().catch(() => undefined)
      return
    }
    if (Math.abs(audio.currentTime - expectedSec) > 0.35) {
      audio.currentTime = expectedSec
    }
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
    audio.currentTime = trackMediaSec(props.audio!, next, 0)
    if (media && !media.paused) void audio.play().catch(() => undefined)
  }

  const bindMusic = (el: HTMLAudioElement, signal: AbortSignal) => {
    musicEl = el
    // Measure every source now (one decode at a time, cached across
    // previews and the overlay) so the levels and playlist boundaries are
    // right by the time playback starts — and realign a bed that already
    // started if a landed measurement moved a boundary under it.
    void (async () => {
      const blobs = [...(props.audio?.tracks ?? []).map((t) => t.blob), props.clip.blob]
      for (const blob of blobs) {
        if (musicEl !== el) return
        await measureAudioNormalization(blob)
        resyncMusicIfPlaying()
      }
    })()

    // Per-frame level hold: constant share for one clip (times the film's
    // edge-fade envelope at the playhead), but the measured scales land
    // asynchronously and the video element remounts on trim changes —
    // recomputing every frame keeps both sides correct.
    let raf = 0
    let last = performance.now()
    /** Gliding element volumes (null = snap to the first computed target).
     * Stepping them instead can click — e.g. the export eases the clip
     * back over PLAYLIST_END_RAMP_MS when the playlist runs out. */
    let musicVol: number | null = null
    let clipVol: number | null = null
    const tick = (now: number) => {
      const dt = Math.min(100, now - last)
      last = now
      const alpha = 1 - Math.exp(-dt / MIX_GLIDE_TAU_MS)
      const glide = (current: number | null, target: number): number => {
        if (current === null) return target
        const next = current + (target - current) * alpha
        return Math.abs(next - target) < 0.005 ? target : next
      }
      // A playlist edit (add / remove / reorder) swaps the record identity
      // while this stage stays mounted — the loaded track index and cached
      // URLs belong to the old playlist then.
      if (audioFor !== props.audio) {
        audioFor = props.audio
        resetMusicForPlaylistChange()
      }
      // A timeline edit (reorder, delete, another clip's trim) moves this
      // clip's film offset — a playing bed must follow to the new
      // export-true position instead of playing on from the old one.
      if (planFor !== props.clips) {
        resolveSegments()
        resyncMusicIfPlaying()
      }
      // A trimmed track never reaches its media's end, so 'ended' cannot
      // fire — hand off to the next track at the kept window's edge.
      if (!el.paused && musicTrackIndex >= 0 && props.audio) {
        const playing = props.audio.tracks[musicTrackIndex]
        if (playing) {
          const endSec = trackMediaSec(
            props.audio,
            musicTrackIndex,
            trackKeptDurationMs(props.audio, playing),
          )
          const mediaEndSec = Number.isFinite(el.duration) ? el.duration : Infinity
          if (endSec < mediaEndSec - 0.05 && el.currentTime >= endSec - 0.03) {
            advanceMusicTrack()
            // The playlist ending at a trimmed LAST track must silence the
            // element (an untrimmed last track ends itself via 'ended').
            if (musicExhausted) el.pause()
          }
        }
      }
      const position = filmPositionMs()
      // The mix envelope is nonzero only where a bed is actually SOUNDING:
      // live playlist coverage (the playhead can pass the last decoded
      // sample before the `ended` handler runs — no bed past the playlist,
      // like the export) AND a playing element (a rejected music play()
      // must not leave a stale level standing).
      const musicHere =
        !musicExhausted && position !== null && trackAtMs(position) !== null && !el.paused
      const mix = musicHere ? musicLevel() * fadeScaleAt(position) : 0
      // The element's volume is the export's music-side gain: envelope ×
      // normalization boost × the track's volume and interior fades.
      const trackBlob = props.audio?.tracks[musicTrackIndex]?.blob
      const musicScale = trackBlob ? (peekAudioNormalization(trackBlob)?.scale ?? 1) : 1
      const musicGain =
        props.audio && musicTrackIndex >= 0
          ? trackMusicGain(props.audio, musicTrackIndex, el.currentTime, filmTotalMs())
          : 1
      musicVol = glide(musicVol, normalizedElementVolume(mix, musicScale * musicGain))
      el.volume = musicVol
      const video = media
      if (video) {
        // The clip's own sound holds ITS OWN level — independent of the
        // music (no ducking, no complement), exactly like the export.
        clipVol = glide(clipVol, clipElementVolumeNow())
        video.volume = clipVol
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
    applyClipVolume()
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
    // A volume edit re-renders the stage without remounting — follow it.
    applyClipVolume()

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
