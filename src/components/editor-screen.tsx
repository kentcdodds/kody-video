import type { Handle, RemixNode } from 'remix/ui'
import { on, ref } from 'remix/ui'
import '../styles/editor.css'
import {
  DEVICE_CLIP_ACCEPT,
  duplicateSelectedClip,
  importDeviceClips,
  moveSelectedClip,
  removeClip,
  setAudioTrackSettings,
  setClipDuration,
  trimClip,
  undoLastDelete,
} from '../lib/project-actions'
import {
  effectiveDurationMs,
  formatDuration,
  isImageClip,
  type ClipId,
  type ClipRecord,
  type Project,
  type ProjectAudioRecord,
  type ProjectId,
} from '../lib/types'
import { AudioDetailStrip } from './audio-detail-strip'
import { AudioStrip } from './audio-strip'
import { EditorClipPreview, type EditorClipPreviewHandle } from './editor-clip-preview'
import {
  IconBack,
  IconChevronLeft,
  IconChevronRight,
  IconDuplicate,
  IconPlay,
  IconPlus,
  IconTrash,
  IconTrim,
  IconUndo,
} from './icons'
import { ImageDurationStrip } from './image-duration-strip'
import { Timeline } from './timeline'
import { TrimStrip } from './trim-strip'
import type { ToastAction } from './record-screen'
import { isInteractiveTarget } from '../lib/keyboard'
import { reportError } from '../lib/error-reporting'
import { THUMB_COUNT, refineClipFilmstrip } from '../lib/thumbs'

interface EditorScreenProps {
  project: Project
  /** Resolves the persisted project id, creating the project when the first
   * clip is added from a lazy "/project/new" shell. */
  ensureProjectId: () => Promise<ProjectId>
  clips: ClipRecord[]
  /** Background-music track for the project (null when none is set). */
  audio: ProjectAudioRecord | null
  /** Kody Video Plus unlocked (background music is a Plus perk). */
  plus: boolean
  /** Open the Plus upsell sheet. */
  onUpsell: () => void
  canUndo: boolean
  /** True while a full-screen overlay owns input (playback, export, …). */
  interactionLocked: boolean
  onOpenCamera: () => void
  onOpenExport: () => void
  onPlay: () => void
  showToast: (message: string, action?: ToastAction) => void
  refresh: () => void | Promise<void>
}

export function EditorScreen(handle: Handle<EditorScreenProps>) {
  const { props } = handle
  let selectedClipId: ClipId | null = props.clips.at(-1)?.id ?? null
  let trimming = false
  /** Track whose detail view (trim, level, fades) is open — the audio
   * counterpart of `trimming`. */
  let editingTrackId: string | null = null
  let importing = false
  /** Clips persisted but not yet in props.clips (refresh still in flight). */
  let optimisticAdds: { clip: ClipRecord; afterId: ClipId | null }[] = []
  let pendingGhostCount = 0
  let ghostAfterId: ClipId | null = null
  const fileInputRef: { current: HTMLInputElement | null } = { current: null }
  const previewApi: { current: EditorClipPreviewHandle | null } = { current: null }

  const visibleClips = (loaded: ClipRecord[]): ClipRecord[] => {
    let next = loaded
    for (const extra of optimisticAdds) {
      if (next.some((clip) => clip.id === extra.clip.id)) continue
      const index = extra.afterId ? next.findIndex((clip) => clip.id === extra.afterId) : -1
      next =
        index >= 0
          ? [...next.slice(0, index + 1), extra.clip, ...next.slice(index + 1)]
          : [...next, extra.clip]
    }
    return next
  }

  const openDevicePicker = () => {
    if (importing || props.interactionLocked) return
    fileInputRef.current?.click()
  }

  const importFromDevice = (files: File[]) => {
    if (files.length === 0 || importing) return
    importing = true
    const afterId = resolveSelectedId()
    ghostAfterId = afterId
    pendingGhostCount = files.length
    optimisticAdds = []
    void handle.update()
    void (async () => {
      try {
        // ensureProjectId runs only after the first file probes successfully
        // — a bad pick on /project/new must not create an empty project.
        const result = await importDeviceClips(files, {
          ensureProjectId: props.ensureProjectId,
          afterClipId: afterId,
          onAdded: (clip) => {
            optimisticAdds = [...optimisticAdds, { clip, afterId: ghostAfterId }]
            ghostAfterId = clip.id
            pendingGhostCount = Math.max(0, pendingGhostCount - 1)
            selectedClipId = clip.id
            trimming = false
            void handle.update()
          },
          onProgress: (done, total) => {
            if (total > 1) {
              props.showToast(`Adding clip ${Math.min(done + 1, total)} of ${total}…`)
            }
          },
        })
        const last = result.added.at(-1)
        if (last) selectedClipId = last.id
        trimming = false
        if (result.added.length > 0) {
          await props.refresh()
          optimisticAdds = []
        }
        if (result.added.length === 0 && result.failed.length > 0) {
          props.showToast(result.failed[0]?.reason || 'Could not add that clip')
        } else if (result.failed.length > 0) {
          props.showToast(
            `Added ${result.added.length} · ${result.failed.length} skipped`,
          )
        } else if (result.added.length === 1) {
          props.showToast('Clip added')
        } else if (result.added.length > 1) {
          props.showToast(`Added ${result.added.length} clips`)
        }
      } catch (err) {
        reportError(err, 'import-device-clips')
        props.showToast(err instanceof Error ? err.message : 'Could not add clips')
      } finally {
        importing = false
        pendingGhostCount = 0
        void handle.update()
      }
    })()
  }

  // Derive a valid selection from the visible clips (loaded + optimistic).
  const resolveSelectedId = (clips?: ClipRecord[]): ClipId | null => {
    const list = clips ?? visibleClips(props.clips)
    return selectedClipId && list.some((c) => c.id === selectedClipId)
      ? selectedClipId
      : (list.at(-1)?.id ?? null)
  }

  const setSelectedClipId = (id: ClipId | null) => {
    selectedClipId = id
    void handle.update()
  }
  const setTrimming = (next: boolean) => {
    trimming = next
    void handle.update()
  }

  const setEditingTrackId = (next: string | null) => {
    editingTrackId = next
    void handle.update()
  }

  const openTrim = (clip: ClipRecord) => {
    previewApi.current?.pause()
    trimming = true
    editingTrackId = null
    // Seek after the commit: entering trim can remount the preview (the trim
    // override changes its remount key), and the seek must land on the new
    // element so the stage opens on the trim-start frame. Photos open the
    // duration strip instead — the stage already shows the whole still.
    if (!isImageClip(clip)) {
      handle.queueTask(() => previewApi.current?.seekToMs(clip.trimStartMs))
    }
    void handle.update()
  }

  const handleDelete = () => {
    const id = resolveSelectedId()
    if (!id) return
    void (async () => {
      await removeClip(id)
      selectedClipId = null
      trimming = false
      void handle.update()
      props.refresh()
      props.showToast('Clip deleted', {
        actionLabel: 'Undo',
        onAction: () => {
          void (async () => {
            const restored = await undoLastDelete(props.project.id)
            if (restored) setSelectedClipId(restored.id)
            props.refresh()
            props.showToast('Clip restored')
          })()
        },
      })
    })()
  }

  // Desktop keyboard support. Closures read live state — no re-binding.
  const onWindowKeyDown = (event: KeyboardEvent) => {
    if (props.interactionLocked || importing) return
    // Escape stays global; everything else yields to focused controls.
    if (event.code !== 'Escape' && isInteractiveTarget(event)) return
    const clips = props.clips
    const resolvedSelectedId = resolveSelectedId()
    const selected = clips.find((c) => c.id === resolvedSelectedId) ?? null
    const selectedIndex = selected ? clips.findIndex((c) => c.id === selected.id) : -1
    if (event.code === 'Escape') {
      if (trimming) {
        previewApi.current?.pause()
        setTrimming(false)
      } else if (editingTrackId) {
        setEditingTrackId(null)
      } else {
        props.onOpenCamera()
      }
      return
    }
    if (trimming || editingTrackId) return
    switch (event.code) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        if (clips.length === 0) return
        event.preventDefault()
        const step = event.code === 'ArrowLeft' ? -1 : 1
        if (event.altKey) {
          // Alt+arrow reorders, matching the Left/Right buttons.
          if (!resolvedSelectedId) return
          const atEdge = step < 0 ? selectedIndex <= 0 : selectedIndex >= clips.length - 1
          if (atEdge) return
          void moveSelectedClip(
            props.project.id,
            resolvedSelectedId,
            step < 0 ? 'left' : 'right',
          ).then(() => props.refresh())
          return
        }
        const nextIndex = Math.min(
          clips.length - 1,
          Math.max(0, (selectedIndex < 0 ? clips.length - 1 : selectedIndex) + step),
        )
        setSelectedClipId(clips[nextIndex].id)
        return
      }
      case 'Backspace':
      case 'Delete': {
        event.preventDefault()
        handleDelete()
        return
      }
      case 'KeyT': {
        if (!selected) return
        openTrim(selected)
        return
      }
      case 'KeyD': {
        if (!resolvedSelectedId) return
        void duplicateSelectedClip(resolvedSelectedId).then((copy) => {
          setSelectedClipId(copy.id)
          props.refresh()
        })
        return
      }
      case 'KeyP': {
        if (clips.length > 0) props.onPlay()
        return
      }
      default:
        return
    }
  }

  // New recordings carry a single live-captured frame (decoding for a full
  // filmstrip behind the live camera preview causes the post-take black
  // flash). Here the camera is released, so upgrade them to the real
  // evenly-spaced strip. Checked after every render with a per-clip attempted
  // set — clips can also arrive through later refreshes (duplicates, undo),
  // not just the mount.
  const refineAttempted = new Set<string>()
  const refineFilmstrips = () => {
    // Ids leave the attempted set when their clip leaves the list: a
    // delete + undo restores the clip from a snapshot that may predate the
    // refinement, and it must get another shot. Clips still present keep
    // their entry, so a failed refinement can't refresh-loop.
    const ids = new Set(props.clips.map((clip) => clip.id))
    for (const id of refineAttempted) {
      if (!ids.has(id)) refineAttempted.delete(id)
    }
    const pending = props.clips.filter((clip) => {
      // A photo's single frame IS its finished filmstrip.
      if (isImageClip(clip)) return false
      const count = clip.thumbs?.length ?? 0
      return count > 0 && count < THUMB_COUNT && !refineAttempted.has(clip.id)
    })
    if (pending.length === 0) return
    for (const clip of pending) {
      refineAttempted.add(clip.id)
    }
    // Serial, like the loader backfill: Android caps concurrent video
    // decoders hard, and each refinement decodes a clip.
    void (async () => {
      for (const clip of pending) {
        await refineClipFilmstrip(clip)
      }
      props.refresh()
    })()
  }

  return () => {
    const { project, canUndo, onOpenCamera, onOpenExport, onPlay } = props
    const loadedIds = new Set(props.clips.map((clip) => clip.id))
    if (optimisticAdds.some((extra) => loadedIds.has(extra.clip.id))) {
      optimisticAdds = optimisticAdds.filter((extra) => !loadedIds.has(extra.clip.id))
    }
    const clips = visibleClips(props.clips)
    const totalDurationMs = clips.reduce((sum, clip) => sum + effectiveDurationMs(clip), 0)
    const resolvedSelectedId = resolveSelectedId(clips)
    const selected = clips.find((c) => c.id === resolvedSelectedId) ?? null
    const selectedIndex = selected ? clips.findIndex((c) => c.id === selected.id) : -1
    // Derive the edited track from the loaded audio (no state syncing) —
    // a removed track simply closes its detail view on the next render.
    const editingTrack = editingTrackId
      ? (props.audio?.tracks.find((track) => track.id === editingTrackId) ?? null)
      : null

    refineFilmstrips()

    return (
      <div
        className={`editor-screen${trimming ? ' is-trimming' : ''}${editingTrack ? ' is-audio-editing' : ''}${importing ? ' is-importing' : ''}`}
        mix={ref((_node, signal) => {
          window.addEventListener('keydown', onWindowKeyDown)
          signal.addEventListener('abort', () => {
            window.removeEventListener('keydown', onWindowKeyDown)
          })
        })}
      >
        <input
          type="file"
          accept={DEVICE_CLIP_ACCEPT}
          multiple
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
              // Copy before clearing: FileList is live and empties with value=''.
              const files = input.files ? [...input.files] : []
              input.value = ''
              importFromDevice(files)
            }),
          ]}
        />
        <div className="editor-top">
          <button
            type="button"
            className="btn-icon"
            aria-label="Back to camera"
            disabled={importing}
            mix={on('click', () => {
              if (importing) return
              onOpenCamera()
            })}
          >
            <IconBack />
          </button>
          <div className="editor-meta">
            <strong>{project.name}</strong>
            <small>
              {clips.length} clip{clips.length === 1 ? '' : 's'} · {formatDuration(totalDurationMs)}
            </small>
          </div>
          <button
            type="button"
            className="btn-icon"
            aria-label="Play project preview"
            disabled={clips.length === 0 || importing}
            mix={on('click', () => onPlay())}
          >
            <IconPlay />
          </button>
        </div>

        <div className="editor-stage">
          {selected ? (
            <EditorClipPreview
              key={selected.id}
              clip={
                trimming
                  ? {
                      ...selected,
                      // While trimming, show full clip so handle seeks are visible.
                      trimStartMs: 0,
                      trimEndMs: selected.durationMs,
                    }
                  : selected
              }
              clips={clips}
              audio={props.audio}
              apiRef={previewApi}
            />
          ) : (
            <div className="editor-empty-preview">Select a clip in the timeline</div>
          )}
        </div>

        <div className="editor-panel">
          {trimming && selected && isImageClip(selected) ? (
            <ImageDurationStrip
              key={selected.id}
              clip={selected}
              onCancel={() => setTrimming(false)}
              onDone={async (durationMs) => {
                await setClipDuration(selected.id, durationMs)
                props.refresh()
                setTrimming(false)
              }}
            />
          ) : trimming && selected ? (
            <TrimStrip
              key={selected.id}
              clip={selected}
              onSeek={(timeMs) => previewApi.current?.seekToMs(timeMs)}
              onCancel={() => {
                previewApi.current?.pause()
                setTrimming(false)
              }}
              onDone={async (trimStartMs, trimEndMs) => {
                await trimClip(selected.id, trimStartMs, trimEndMs)
                props.refresh()
                previewApi.current?.pause()
                setTrimming(false)
              }}
            />
          ) : editingTrack && props.audio ? (
            <AudioDetailStrip
              key={editingTrack.id}
              track={editingTrack}
              playlist={props.audio}
              trackIndex={props.audio.tracks.findIndex((track) => track.id === editingTrack.id)}
              onCancel={() => setEditingTrackId(null)}
              onDone={async (draft) => {
                await setAudioTrackSettings(props.audio!.projectId, editingTrack.id, draft)
                props.refresh()
                setEditingTrackId(null)
              }}
            />
          ) : (
            <Timeline
              projectId={project.id}
              clips={clips}
              selectedClipId={resolvedSelectedId}
              onSelect={(id) => {
                selectedClipId = id
                trimming = false
                void handle.update()
              }}
              onAddFromDevice={openDevicePicker}
              addingFromDevice={importing}
              pendingGhostCount={pendingGhostCount}
              pendingGhostAfterId={ghostAfterId}
              showAudioBadges={props.audio !== null}
              refresh={props.refresh}
            />
          )}

          {!trimming && !editingTrack ? (
            <AudioStrip
              ensureProjectId={props.ensureProjectId}
              audio={props.audio}
              selectedClip={selected}
              selectedIndex={selectedIndex}
              projectDurationMs={totalDurationMs}
              disabled={importing}
              plus={props.plus}
              onUpsell={props.onUpsell}
              onEditTrack={(trackId) => {
                previewApi.current?.pause()
                trimming = false
                setEditingTrackId(trackId)
              }}
              showToast={props.showToast}
              refresh={props.refresh}
            />
          ) : null}

          {!trimming && !editingTrack ? (
            <div className="editor-actions" role="toolbar" aria-label="Clip actions">
              <ActionButton
                label="Delete"
                ariaLabel="Delete clip"
                disabled={!selected || importing}
                tone="danger"
                onClick={handleDelete}
                icon={<IconTrash />}
              />
              <ActionButton
                label="Duplicate"
                ariaLabel="Duplicate clip"
                disabled={!selected || importing}
                onClick={() => {
                  if (!resolvedSelectedId) return
                  void duplicateSelectedClip(resolvedSelectedId).then((copy) => {
                    setSelectedClipId(copy.id)
                    props.refresh()
                  })
                }}
                icon={<IconDuplicate />}
              />
              <ActionButton
                label={selected && isImageClip(selected) ? 'Duration' : 'Trim'}
                ariaLabel={
                  selected && isImageClip(selected) ? 'Set photo duration' : 'Trim clip'
                }
                disabled={!selected || importing}
                prominent
                onClick={() => {
                  if (selected) openTrim(selected)
                }}
                icon={<IconTrim />}
              />
              <ActionButton
                label="Left"
                ariaLabel="Move clip left"
                disabled={!selected || selectedIndex <= 0 || importing}
                onClick={() => {
                  if (!resolvedSelectedId) return
                  void moveSelectedClip(project.id, resolvedSelectedId, 'left').then(() =>
                    props.refresh(),
                  )
                }}
                icon={<IconChevronLeft />}
              />
              <ActionButton
                label="Right"
                ariaLabel="Move clip right"
                disabled={!selected || selectedIndex >= clips.length - 1 || importing}
                onClick={() => {
                  if (!resolvedSelectedId) return
                  void moveSelectedClip(project.id, resolvedSelectedId, 'right').then(() =>
                    props.refresh(),
                  )
                }}
                icon={<IconChevronRight />}
              />
            </div>
          ) : null}

          <div className="editor-toolbar">
            <div className="editor-toolbar-start">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={importing}
                aria-label="Add clips from device"
                mix={on('click', () => openDevicePicker())}
              >
                <IconPlus size={18} />
                Add
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!canUndo || importing}
                mix={on('click', () => {
                  void (async () => {
                    const restored = await undoLastDelete(project.id)
                    if (restored) setSelectedClipId(restored.id)
                    props.refresh()
                    props.showToast('Clip restored')
                  })()
                })}
              >
                <IconUndo size={18} />
                Undo delete
              </button>
            </div>
            <button
              type="button"
              className="go-button compact"
              disabled={clips.length === 0 || importing}
              mix={on('click', () => onOpenExport())}
            >
              Go
            </button>
          </div>

          <div className="key-hints" aria-hidden="true">
            <kbd>←</kbd>/<kbd>→</kbd> select · <kbd>Alt</kbd>+arrows move · <kbd>T</kbd> trim ·{' '}
            <kbd>D</kbd> duplicate · <kbd>⌫</kbd> delete · <kbd>P</kbd> play · <kbd>Esc</kbd> camera
          </div>
        </div>
      </div>
    )
  }
}

function ActionButton(
  handle: Handle<{
    label: string
    ariaLabel?: string
    icon: RemixNode
    disabled?: boolean
    onClick: () => void
    prominent?: boolean
    tone?: 'danger'
  }>,
) {
  return () => {
    const { label, ariaLabel, icon, disabled, prominent, tone } = handle.props
    return (
      <button
        type="button"
        className={`editor-action${prominent ? ' prominent' : ''}${tone === 'danger' ? ' danger' : ''}`}
        disabled={disabled}
        aria-label={ariaLabel ?? label}
        mix={on('click', () => handle.props.onClick())}
      >
        <span className="editor-action-icon">{icon}</span>
        <span className="editor-action-label">{label}</span>
      </button>
    )
  }
}
