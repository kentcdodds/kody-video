import type { Handle } from 'remix/ui'
import { on, ref } from 'remix/ui'
import { AUDIO_FILE_ACCEPT, AudioImportError } from '../lib/audio-import'
import { reportError } from '../lib/error-reporting'
import {
  addProjectAudioFromFile,
  removeProjectAudioTrack,
  setClipAudioVolume,
  setProjectAudioDefaultVolume,
} from '../lib/project-actions'
import {
  clipAudioVolume,
  formatDuration,
  type ClipId,
  type ClipRecord,
  type ProjectAudioRecord,
  type ProjectId,
} from '../lib/types'
import { IconClose, IconLock, IconMusic } from './icons'

interface AudioStripProps {
  /** Resolves the persisted project id (creates it from a lazy "new" shell). */
  ensureProjectId: () => Promise<ProjectId>
  audio: ProjectAudioRecord | null
  selectedClip: ClipRecord | null
  /** Index of the selected clip in the timeline (for the row label). */
  selectedIndex: number
  disabled: boolean
  /** Background music is a Kody Video Plus perk. */
  plus: boolean
  /** Open the Plus upsell sheet (owned by the page, like restore). */
  onUpsell: () => void
  showToast: (message: string) => void
  refresh: () => void
}

/**
 * Background-music panel under the timeline: pick a track, set its default
 * volume, and dial the music volume for the selected clip. Volume writes
 * persist on slider release; the label tracks the thumb live.
 */
export function AudioStrip(handle: Handle<AudioStripProps>) {
  const { props } = handle
  let busy = false
  const fileInputRef: { current: HTMLInputElement | null } = { current: null }
  /** Slider positions mid-drag / awaiting the post-write refresh — they keep
   * the thumb steady until props catch up with what was persisted. */
  let pendingDefault: number | null = null
  let pendingClip: { clipId: ClipId; volume: number } | null = null

  const setBusy = (next: boolean) => {
    busy = next
    void handle.update()
  }

  const addFromFile = (file: File | undefined) => {
    if (!file || busy) return
    setBusy(true)
    void (async () => {
      try {
        await addProjectAudioFromFile(file, props.ensureProjectId)
        props.showToast('Music added — it plays under every clip')
        props.refresh()
      } catch (err) {
        if (!(err instanceof AudioImportError)) reportError(err, 'add-project-audio')
        props.showToast(err instanceof Error ? err.message : 'Could not add that audio file')
      } finally {
        setBusy(false)
      }
    })()
  }

  const removeTrack = () => {
    const audio = props.audio
    if (!audio || busy) return
    setBusy(true)
    void (async () => {
      try {
        await removeProjectAudioTrack(audio.projectId)
        pendingDefault = null
        pendingClip = null
        props.showToast('Music removed')
        props.refresh()
      } finally {
        setBusy(false)
      }
    })()
  }

  const commitDefaultVolume = (volume: number) => {
    const audio = props.audio
    if (!audio) return
    pendingDefault = volume
    void setProjectAudioDefaultVolume(audio.projectId, volume).then(() => props.refresh())
  }

  const commitClipVolume = (clipId: ClipId, volume: number) => {
    pendingClip = { clipId, volume }
    void setClipAudioVolume(clipId, volume).then(() => props.refresh())
  }

  const resetClipVolume = (clipId: ClipId) => {
    pendingClip = null
    void setClipAudioVolume(clipId, null).then(() => props.refresh())
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

    // Drop the held slider positions once a refresh delivered them back.
    if (pendingDefault !== null && Math.abs(audio.defaultVolume - pendingDefault) < 0.005) {
      pendingDefault = null
    }
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
    const clipVolume = selectedClip
      ? pendingClip?.clipId === selectedClip.id
        ? pendingClip.volume
        : clipAudioVolume(selectedClip, audio.defaultVolume)
      : defaultVolume

    return (
      <div key="audio-strip" className="audio-strip has-track">
        {fileInput}
        <div className="audio-track-row">
          <span className="audio-track-icon" aria-hidden="true">
            <IconMusic size={16} />
          </span>
          <button
            type="button"
            className="audio-track-name"
            disabled={disabled || busy}
            aria-label={`Replace background music (currently ${audio.name})`}
            title="Replace music"
            mix={on('click', () => fileInputRef.current?.click())}
          >
            {audio.name}
          </button>
          <span className="audio-track-duration muted">{formatDuration(audio.durationMs)}</span>
          <button
            type="button"
            className="btn-icon audio-remove"
            disabled={disabled || busy}
            aria-label="Remove background music"
            mix={on('click', () => removeTrack())}
          >
            <IconClose size={16} />
          </button>
        </div>

        {selectedClip ? (
          <div className="audio-volume-row">
            <span className="audio-volume-label">
              Clip {selectedIndex + 1}
              {clipOverridden ? '' : ' · default'}
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(clipVolume * 100)}
              disabled={disabled || busy}
              aria-label={`Music volume during clip ${selectedIndex + 1}`}
              mix={[
                on('input', (event) => {
                  const volume = Number((event.currentTarget as HTMLInputElement).value) / 100
                  pendingClip = { clipId: selectedClip.id, volume }
                  void handle.update()
                }),
                on('change', (event) => {
                  const volume = Number((event.currentTarget as HTMLInputElement).value) / 100
                  commitClipVolume(selectedClip.id, volume)
                }),
              ]}
            />
            <span className="audio-volume-value">{Math.round(clipVolume * 100)}%</span>
            <button
              type="button"
              className="audio-volume-reset"
              disabled={disabled || busy || !clipOverridden}
              aria-label="Reset this clip to the default music volume"
              mix={on('click', () => resetClipVolume(selectedClip.id))}
            >
              Reset
            </button>
          </div>
        ) : null}

        <div className="audio-volume-row">
          <span className="audio-volume-label">All clips</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(defaultVolume * 100)}
            disabled={disabled || busy}
            aria-label="Default music volume"
            mix={[
              on('input', (event) => {
                pendingDefault = Number((event.currentTarget as HTMLInputElement).value) / 100
                void handle.update()
              }),
              on('change', (event) => {
                const volume = Number((event.currentTarget as HTMLInputElement).value) / 100
                commitDefaultVolume(volume)
              }),
            ]}
          />
          <span className="audio-volume-value">{Math.round(defaultVolume * 100)}%</span>
        </div>
      </div>
    )
  }
}
