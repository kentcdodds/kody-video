import type { Handle } from 'remix/ui'
import { on, ref } from 'remix/ui'
import { AUDIO_FILE_ACCEPT, AudioImportError } from '../lib/audio-import'
import { reportError } from '../lib/error-reporting'
import {
  addProjectAudioFromFile,
  removeAudioTrack,
  setClipAudioVolume,
  setProjectAudioSettings,
} from '../lib/project-actions'
import {
  clipAudioVolume,
  formatDuration,
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
  showToast: (message: string) => void
  refresh: () => void
}

/**
 * Background-music panel under the timeline: build a playlist of tracks
 * (played one after the other until the film ends), toggle the fade in/out,
 * set the default volume, and dial the music volume for the selected clip.
 * Volume writes persist on slider release; the label tracks the thumb live.
 */
export function AudioStrip(handle: Handle<AudioStripProps>) {
  const { props } = handle
  let busy = false
  const fileInputRef: { current: HTMLInputElement | null } = { current: null }
  /** Slider/toggle values mid-edit / awaiting the post-write refresh — they
   * keep the controls steady until props catch up with what was persisted. */
  let pendingDefault: number | null = null
  let pendingClip: { clipId: ClipId; volume: number } | null = null
  let pendingFadeIn: boolean | null = null
  let pendingFadeOut: boolean | null = null

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
        pendingDefault = null
        pendingClip = null
        pendingFadeIn = null
        pendingFadeOut = null
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

  const setFade = (which: 'fadeIn' | 'fadeOut', enabled: boolean) => {
    const audio = props.audio
    if (!audio) return
    if (which === 'fadeIn') pendingFadeIn = enabled
    else pendingFadeOut = enabled
    void handle.update()
    persist(setProjectAudioSettings(audio.projectId, { [which]: enabled }))
  }

  const commitDefaultVolume = (volume: number) => {
    const audio = props.audio
    if (!audio) return
    pendingDefault = volume
    persist(setProjectAudioSettings(audio.projectId, { defaultVolume: volume }))
  }

  const commitClipVolume = (clipId: ClipId, volume: number) => {
    pendingClip = { clipId, volume }
    persist(setClipAudioVolume(clipId, volume))
  }

  const resetClipVolume = (clipId: ClipId) => {
    pendingClip = null
    persist(setClipAudioVolume(clipId, null))
    void handle.update()
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
        </div>
      )
    }

    // Drop the held control values once a refresh delivered them back.
    if (pendingDefault !== null && Math.abs(audio.defaultVolume - pendingDefault) < 0.005) {
      pendingDefault = null
    }
    if (pendingFadeIn !== null && audio.fadeIn === pendingFadeIn) pendingFadeIn = null
    if (pendingFadeOut !== null && audio.fadeOut === pendingFadeOut) pendingFadeOut = null
    if (
      pendingClip !== null &&
      (selectedClip?.id !== pendingClip.clipId ||
        (selectedClip.audioVolume !== undefined &&
          Math.abs(selectedClip.audioVolume - pendingClip.volume) < 0.005))
    ) {
      pendingClip = null
    }

    const defaultVolume = pendingDefault ?? audio.defaultVolume
    const clipOverridden = selectedClip
      ? pendingClip?.clipId === selectedClip.id || selectedClip.audioVolume !== undefined
      : false
    // Follows the pending default too, so both rows agree mid-drag.
    const clipVolume = selectedClip
      ? pendingClip?.clipId === selectedClip.id
        ? pendingClip.volume
        : clipAudioVolume(selectedClip, defaultVolume)
      : defaultVolume

    const musicMs = projectAudioTotalDurationMs(audio)
    const musicEndsEarly = props.projectDurationMs > 0 && musicMs < props.projectDurationMs

    return (
      <div key="audio-strip" className="audio-strip has-track">
        {fileInput}
        {audio.tracks.map((track, trackIndex) => (
          <div key={track.id} className="audio-track-row">
            <span className="audio-track-icon" aria-hidden="true">
              <IconMusic size={16} />
            </span>
            <span
              className="audio-track-name"
              title={audio.tracks.length > 1 ? `Track ${trackIndex + 1}: ${track.name}` : track.name}
            >
              {track.name}
            </span>
            <span className="audio-track-duration muted">{formatDuration(track.durationMs)}</span>
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
        ))}

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
          <span className="audio-fades" role="group" aria-label="Music fades">
            <label className="audio-fade-toggle">
              <input
                type="checkbox"
                checked={pendingFadeIn ?? audio.fadeIn}
                disabled={disabled || busy}
                aria-label="Fade the music in at the start"
                mix={on('change', (event) => {
                  setFade('fadeIn', (event.currentTarget as HTMLInputElement).checked)
                })}
              />
              Fade in
            </label>
            <label className="audio-fade-toggle">
              <input
                type="checkbox"
                checked={pendingFadeOut ?? audio.fadeOut}
                disabled={disabled || busy}
                aria-label="Fade the music out at the end"
                mix={on('change', (event) => {
                  setFade('fadeOut', (event.currentTarget as HTMLInputElement).checked)
                })}
              />
              Fade out
            </label>
          </span>
        </div>

        {selectedClip ? (
          <MixRow
            label={`Clip ${selectedIndex + 1}${clipOverridden ? '' : ' · default'}`}
            ariaLabel={`Audio mix during clip ${selectedIndex + 1}`}
            share={clipVolume}
            disabled={disabled || busy}
            onPreview={(share) => {
              pendingClip = { clipId: selectedClip.id, volume: share }
              void handle.update()
            }}
            onCommit={(share) => commitClipVolume(selectedClip.id, share)}
            onReset={clipOverridden ? () => resetClipVolume(selectedClip.id) : undefined}
          />
        ) : null}

        <MixRow
          label="All clips"
          ariaLabel="Default audio mix"
          share={defaultVolume}
          disabled={disabled || busy}
          onPreview={(share) => {
            pendingDefault = share
            void handle.update()
          }}
          onCommit={(share) => commitDefaultVolume(share)}
        />
      </div>
    )
  }
}

interface MixRowProps {
  label: string
  ariaLabel: string
  /** Music's share of the mix (0–1); the clip's own sound gets the rest. */
  share: number
  disabled: boolean
  /** Live thumb move (label preview only — nothing persisted yet). */
  onPreview: (share: number) => void
  /** Slider released — persist. */
  onCommit: (share: number) => void
  /** Present only when the row is overridable and currently overridden. */
  onReset?: () => void
}

/** One balance slider: clip sound on the left, music on the right — drag
 * toward the side that should carry more of the mix. */
function MixRow(handle: Handle<MixRowProps>) {
  return () => {
    const { label, ariaLabel, share, disabled, onReset } = handle.props
    const musicPct = Math.round(share * 100)
    const clipPct = 100 - musicPct
    return (
      <div className="audio-mix-row">
        <span className="audio-volume-label">{label}</span>
        <span className="audio-mix-side" aria-hidden="true">
          Clip <strong>{clipPct}%</strong>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={musicPct}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-valuetext={`${clipPct}% clip sound, ${musicPct}% music`}
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
        <span className="audio-mix-side" aria-hidden="true">
          <strong>{musicPct}%</strong> Music
        </span>
        {onReset ? (
          <button
            type="button"
            className="audio-volume-reset"
            disabled={disabled}
            aria-label="Reset this clip to the default audio mix"
            mix={on('click', () => handle.props.onReset?.())}
          >
            Reset
          </button>
        ) : null}
      </div>
    )
  }
}
