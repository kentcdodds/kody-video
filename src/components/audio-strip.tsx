import type { Handle } from 'remix/ui'
import { on, ref } from 'remix/ui'
import { AUDIO_FILE_ACCEPT, AudioImportError } from '../lib/audio-import'
import { reportError } from '../lib/error-reporting'
import {
  addProjectAudioFromFile,
  removeAudioTrack,
  setClipVolumes,
} from '../lib/project-actions'
import {
  audioTrackKeptMs,
  audioTrackLevel,
  clipMusicVolume,
  clipSoundVolume,
  formatDuration,
  isImageClip,
  projectAudioTotalDurationMs,
  type ClipId,
  type ClipRecord,
  type ProjectAudioRecord,
  type ProjectId,
} from '../lib/types'
import { IconClose, IconLock, IconMusic, IconPlus } from './icons'

interface AudioStripProps {
  /** Resolves the persisted project id (creates it from a lazy "new" shell). */
  ensureProjectId: () => Promise<ProjectId>
  audio: ProjectAudioRecord | null
  selectedClip: ClipRecord | null
  /** Index of the selected clip in the timeline (for the row label). */
  selectedIndex: number
  /** Total film length — drives the "music ends early" hint. */
  projectDurationMs: number
  disabled: boolean
  /** Background music is a Kody Video Plus perk. */
  plus: boolean
  /** Open the Plus upsell sheet (owned by the page, like restore). */
  onUpsell: () => void
  /** Open a track's detail view (trim, volume, fades) — owned by the editor
   * screen, like the clip trim view. */
  onEditTrack: (trackId: string) => void
  showToast: (message: string) => void
  refresh: () => void
}

/** A pending slider value for one clip, mid-edit / awaiting the post-write
 * refresh. */
interface PendingClipVolume {
  clipId: ClipId
  volume: number
}

/**
 * Audio panel under the timeline: build a background-music playlist of
 * tracks (played one after the other until the film ends) and dial the
 * selected clip's levels — its own sound and the music under it, each an
 * independent 0–100% volume (100% is the default; the music slider ducks
 * the playing track's own volume). Tapping a track row opens its detail
 * view (trim, volume, fades — the audio counterpart of the clip trim
 * view), whose volume slider is where the music's base level lives.
 * Volume writes persist on slider release; the label tracks the thumb
 * live.
 */
export function AudioStrip(handle: Handle<AudioStripProps>) {
  const { props } = handle
  let busy = false
  const fileInputRef: { current: HTMLInputElement | null } = { current: null }
  /** Slider values mid-edit / awaiting the post-write refresh — they keep
   * the controls steady until props catch up with what was persisted. */
  let pendingClipSound: PendingClipVolume | null = null
  let pendingClipMusic: PendingClipVolume | null = null

  const setBusy = (next: boolean) => {
    busy = next
    void handle.update()
  }

  const addFromFile = (file: File | undefined) => {
    if (!file || busy) return
    setBusy(true)
    void (async () => {
      try {
        const record = await addProjectAudioFromFile(file, props.ensureProjectId)
        props.showToast(
          record.tracks.length === 1
            ? 'Music added — it plays under every clip'
            : `Track ${record.tracks.length} added — it plays after the previous one`,
        )
        props.refresh()
      } catch (err) {
        if (!(err instanceof AudioImportError)) reportError(err, 'add-project-audio')
        props.showToast(err instanceof Error ? err.message : 'Could not add that audio file')
      } finally {
        setBusy(false)
      }
    })()
  }

  /** Run a persistence write; on failure surface it, drop the held control
   * values (so the UI snaps back to the stored state), and still refresh. */
  const persist = (write: Promise<unknown>) => {
    void write
      .then(() => props.refresh())
      .catch((err) => {
        reportError(err, 'project-audio')
        pendingClipSound = null
        pendingClipMusic = null
        props.showToast('Could not save that change — try again')
        props.refresh()
        void handle.update()
      })
  }

  const removeTrack = (trackId: string) => {
    const audio = props.audio
    if (!audio || busy) return
    setBusy(true)
    void (async () => {
      try {
        await removeAudioTrack(audio.projectId, trackId)
        props.showToast(audio.tracks.length === 1 ? 'Music removed' : 'Track removed')
        props.refresh()
      } catch (err) {
        reportError(err, 'project-audio')
        props.showToast('Could not remove that track — try again')
      } finally {
        setBusy(false)
      }
    })()
  }

  const commitClipSound = (clipId: ClipId, volume: number) => {
    pendingClipSound = { clipId, volume }
    persist(setClipVolumes(clipId, { clipVolume: volume }))
  }

  const commitClipMusic = (clipId: ClipId, volume: number) => {
    pendingClipMusic = { clipId, volume }
    persist(setClipVolumes(clipId, { musicVolume: volume }))
  }

  return () => {
    const { audio, selectedClip, selectedIndex, disabled } = props

    const fileInput = (
      <input
        type="file"
        accept={AUDIO_FILE_ACCEPT}
        className="visually-hidden"
        tabindex={-1}
        aria-hidden="true"
        mix={[
          ref((node, signal) => {
            fileInputRef.current = node as HTMLInputElement
            signal.addEventListener('abort', () => {
              if (fileInputRef.current === node) fileInputRef.current = null
            })
          }),
          on('change', (event) => {
            const input = event.currentTarget as HTMLInputElement
            const file = input.files?.[0]
            input.value = ''
            addFromFile(file)
          }),
        ]}
      />
    )

    // Drop the held control values once a refresh delivered them back (or
    // the selection moved on).
    if (
      pendingClipSound !== null &&
      (selectedClip?.id !== pendingClipSound.clipId ||
        Math.abs(clipSoundVolume(selectedClip) - pendingClipSound.volume) < 0.005)
    ) {
      pendingClipSound = null
    }
    if (
      pendingClipMusic !== null &&
      (selectedClip?.id !== pendingClipMusic.clipId ||
        Math.abs(clipMusicVolume(selectedClip) - pendingClipMusic.volume) < 0.005)
    ) {
      pendingClipMusic = null
    }

    const clipSound = selectedClip
      ? (pendingClipSound?.volume ?? clipSoundVolume(selectedClip))
      : 1
    const clipMusic = selectedClip
      ? (pendingClipMusic?.volume ?? clipMusicVolume(selectedClip))
      : 1

    // The clip's own sound volume applies with or without music (and on
    // the free plan) — it is about the clip, not the playlist. Photos are
    // silent by construction, so they get no sound dial (the music dial
    // below still applies — ducking music under a photo is meaningful).
    const clipSoundRow = selectedClip && !isImageClip(selectedClip) ? (
      <VolumeRow
        label={`Clip ${selectedIndex + 1} sound`}
        ariaLabel={`Clip ${selectedIndex + 1} sound volume`}
        volume={clipSound}
        disabled={disabled || busy}
        onPreview={(volume) => {
          pendingClipSound = { clipId: selectedClip.id, volume }
          void handle.update()
        }}
        onCommit={(volume) => commitClipSound(selectedClip.id, volume)}
      />
    ) : null

    if (!audio) {
      // Free plan: the button stays visible (discoverable) but opens the
      // Plus upsell instead of the file picker.
      if (!props.plus) {
        return (
          <div key="audio-strip-locked" className="audio-strip">
            <button
              type="button"
              className="btn btn-ghost audio-add audio-add-locked"
              disabled={disabled}
              aria-label="Add background music (Kody Video Plus)"
              mix={on('click', () => props.onUpsell())}
            >
              <IconMusic size={18} />
              Add music
              <span className="audio-plus-lock" aria-hidden="true">
                <IconLock size={13} />
              </span>
            </button>
            {clipSoundRow}
          </div>
        )
      }
      return (
        <div key="audio-strip-empty" className="audio-strip">
          {fileInput}
          <button
            type="button"
            className="btn btn-ghost audio-add"
            disabled={disabled || busy}
            aria-label="Add background music"
            mix={on('click', () => fileInputRef.current?.click())}
          >
            <IconMusic size={18} />
            {busy ? 'Adding music…' : 'Add music'}
          </button>
          {clipSoundRow}
        </div>
      )
    }

    const musicMs = projectAudioTotalDurationMs(audio)
    const musicEndsEarly = props.projectDurationMs > 0 && musicMs < props.projectDurationMs

    return (
      <div key="audio-strip" className="audio-strip has-track">
        {fileInput}
        {audio.tracks.map((track, trackIndex) => {
          const keptMs = audioTrackKeptMs(track)
          const trimmed = keptMs < track.durationMs
          const volumePct = Math.round(audioTrackLevel(track) * 100)
          return (
            <div key={track.id} className="audio-track-row">
              <button
                type="button"
                className="audio-track-open"
                disabled={disabled || busy}
                aria-label={`Edit music track ${trackIndex + 1} (${track.name})`}
                title="Trim, volume, and fades"
                mix={on('click', () => props.onEditTrack(track.id))}
              >
                <span className="audio-track-icon" aria-hidden="true">
                  <IconMusic size={16} />
                </span>
                <span
                  className="audio-track-name"
                  title={
                    audio.tracks.length > 1 ? `Track ${trackIndex + 1}: ${track.name}` : track.name
                  }
                >
                  {track.name}
                </span>
                <span className="audio-track-duration muted">
                  {formatDuration(keptMs)}
                  {trimmed ? ' kept' : ''}
                  {` · ${volumePct}%`}
                </span>
              </button>
              <button
                type="button"
                className="btn-icon audio-remove"
                disabled={disabled || busy}
                aria-label={`Remove music track ${trackIndex + 1} (${track.name})`}
                mix={on('click', () => removeTrack(track.id))}
              >
                <IconClose size={16} />
              </button>
            </div>
          )
        })}

        <div className="audio-playlist-row">
          <button
            type="button"
            className="audio-add-track"
            disabled={disabled || busy}
            aria-label="Add another music track"
            mix={on('click', () => fileInputRef.current?.click())}
          >
            <IconPlus size={14} />
            Add track
          </button>
          {musicEndsEarly ? (
            <span className="audio-coverage-hint muted">
              Music ends at {formatDuration(musicMs)} of {formatDuration(props.projectDurationMs)}
            </span>
          ) : null}
        </div>

        {clipSoundRow}
        {selectedClip ? (
          <VolumeRow
            label={`Clip ${selectedIndex + 1} music`}
            ariaLabel={`Music volume during clip ${selectedIndex + 1}`}
            volume={clipMusic}
            disabled={disabled || busy}
            onPreview={(volume) => {
              pendingClipMusic = { clipId: selectedClip.id, volume }
              void handle.update()
            }}
            onCommit={(volume) => commitClipMusic(selectedClip.id, volume)}
          />
        ) : null}
      </div>
    )
  }
}

interface VolumeRowProps {
  label: string
  ariaLabel: string
  /** The level (0–1); 1 (100%) is the default and stores no override. */
  volume: number
  disabled: boolean
  /** Live thumb move (label preview only — nothing persisted yet). */
  onPreview: (volume: number) => void
  /** Slider released — persist. */
  onCommit: (volume: number) => void
}

/** One volume slider: 0% silences that side for this clip, 100% (default)
 * plays it at its full mixed level. */
function VolumeRow(handle: Handle<VolumeRowProps>) {
  return () => {
    const { label, ariaLabel, volume, disabled } = handle.props
    const pct = Math.round(volume * 100)
    return (
      <div className="audio-volume-row">
        <span className="audio-volume-label">{label}</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={pct}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-valuetext={`${pct}% volume`}
          mix={[
            on('input', (event) => {
              handle.props.onPreview(
                Number((event.currentTarget as HTMLInputElement).value) / 100,
              )
            }),
            on('change', (event) => {
              handle.props.onCommit(
                Number((event.currentTarget as HTMLInputElement).value) / 100,
              )
            }),
          ]}
        />
        <strong className="audio-volume-value">{pct}%</strong>
      </div>
    )
  }
}
