import { useRef, useState, type ReactNode } from 'react'
import {
  duplicateSelectedClip,
  moveSelectedClip,
  removeClip,
  trimClip,
  undoLastDelete,
} from '../lib/project-actions'
import { effectiveDurationMs, formatDuration, type ClipId, type ClipRecord, type Project } from '../lib/types'
import {
  EditorClipPreview,
  type EditorClipPreviewHandle,
} from './editor-clip-preview'
import {
  IconBack,
  IconChevronLeft,
  IconChevronRight,
  IconDuplicate,
  IconPlay,
  IconTrash,
  IconTrim,
  IconUndo,
} from './icons'
import { Timeline } from './timeline'
import { TrimStrip } from './trim-strip'
import type { ToastAction } from './record-screen'

interface EditorScreenProps {
  project: Project
  clips: ClipRecord[]
  canUndo: boolean
  onOpenCamera: () => void
  onOpenExport: () => void
  onPlay: () => void
  showToast: (message: string, action?: ToastAction) => void
  refresh: () => void
}

export function EditorScreen({
  project,
  clips,
  canUndo,
  onOpenCamera,
  onOpenExport,
  onPlay,
  showToast,
  refresh,
}: EditorScreenProps) {
  const [selectedClipId, setSelectedClipId] = useState<ClipId | null>(
    () => clips.at(-1)?.id ?? null,
  )
  const [trimming, setTrimming] = useState(false)
  const previewApiRef = useRef<EditorClipPreviewHandle | null>(null)

  const totalDurationMs = clips.reduce((sum, clip) => sum + effectiveDurationMs(clip), 0)

  // Derive a valid selection from loader data (avoid syncing with an effect).
  const resolvedSelectedId =
    selectedClipId && clips.some((c) => c.id === selectedClipId)
      ? selectedClipId
      : (clips.at(-1)?.id ?? null)
  const selected = clips.find((c) => c.id === resolvedSelectedId) ?? null
  const selectedIndex = selected ? clips.findIndex((c) => c.id === selected.id) : -1

  const handleDelete = () => {
    if (!resolvedSelectedId) return
    void (async () => {
      await removeClip(resolvedSelectedId)
      setSelectedClipId(null)
      setTrimming(false)
      refresh()
      showToast('Clip deleted', {
        actionLabel: 'Undo',
        onAction: () => {
          void (async () => {
            const restored = await undoLastDelete(project.id)
            if (restored) setSelectedClipId(restored.id)
            refresh()
            showToast('Clip restored')
          })()
        },
      })
    })()
  }

  return (
    <div className={`editor-screen${trimming ? ' is-trimming' : ''}`}>
      <div className="editor-top">
        <button type="button" className="btn-icon" aria-label="Back to camera" onClick={onOpenCamera}>
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
          disabled={clips.length === 0}
          onClick={onPlay}
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
            apiRef={previewApiRef}
          />
        ) : (
          <div className="editor-empty-preview">Select a clip in the timeline</div>
        )}
      </div>

      <div className="editor-panel">
        {trimming && selected ? (
          <TrimStrip
            key={selected.id}
            clip={selected}
            onSeek={(timeMs) => previewApiRef.current?.seekToMs(timeMs)}
            onCancel={() => {
              previewApiRef.current?.pause()
              setTrimming(false)
            }}
            onDone={async (trimStartMs, trimEndMs) => {
              await trimClip(selected.id, trimStartMs, trimEndMs)
              refresh()
              previewApiRef.current?.pause()
              setTrimming(false)
            }}
          />
        ) : (
          <Timeline
            projectId={project.id}
            clips={clips}
            selectedClipId={resolvedSelectedId}
            onSelect={(id) => {
              setSelectedClipId(id)
              setTrimming(false)
            }}
            refresh={refresh}
          />
        )}

        {!trimming ? (
          <div className="editor-actions" role="toolbar" aria-label="Clip actions">
            <ActionButton
              label="Delete"
              ariaLabel="Delete clip"
              disabled={!selected}
              tone="danger"
              onClick={handleDelete}
              icon={<IconTrash />}
            />
            <ActionButton
              label="Duplicate"
              ariaLabel="Duplicate clip"
              disabled={!selected}
              onClick={() => {
                if (!resolvedSelectedId) return
                void duplicateSelectedClip(resolvedSelectedId).then((copy) => {
                  setSelectedClipId(copy.id)
                  refresh()
                })
              }}
              icon={<IconDuplicate />}
            />
            <ActionButton
              label="Trim"
              disabled={!selected}
              prominent
              onClick={() => {
                previewApiRef.current?.pause()
                setTrimming(true)
              }}
              icon={<IconTrim />}
            />
            <ActionButton
              label="Left"
              ariaLabel="Move clip left"
              disabled={!selected || selectedIndex <= 0}
              onClick={() => {
                if (!resolvedSelectedId) return
                void moveSelectedClip(project.id, resolvedSelectedId, 'left').then(refresh)
              }}
              icon={<IconChevronLeft />}
            />
            <ActionButton
              label="Right"
              ariaLabel="Move clip right"
              disabled={!selected || selectedIndex >= clips.length - 1}
              onClick={() => {
                if (!resolvedSelectedId) return
                void moveSelectedClip(project.id, resolvedSelectedId, 'right').then(refresh)
              }}
              icon={<IconChevronRight />}
            />
          </div>
        ) : null}

        <div className="editor-toolbar">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!canUndo}
            onClick={() => {
              void (async () => {
                const restored = await undoLastDelete(project.id)
                if (restored) setSelectedClipId(restored.id)
                refresh()
                showToast('Clip restored')
              })()
            }}
          >
            <IconUndo size={18} />
            Undo delete
          </button>
          <button
            type="button"
            className="ok-button compact"
            disabled={clips.length === 0}
            onClick={onOpenExport}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  )
}

function ActionButton({
  label,
  ariaLabel,
  icon,
  disabled,
  onClick,
  prominent,
  tone,
}: {
  label: string
  ariaLabel?: string
  icon: ReactNode
  disabled?: boolean
  onClick: () => void
  prominent?: boolean
  tone?: 'danger'
}) {
  return (
    <button
      type="button"
      className={`editor-action${prominent ? ' prominent' : ''}${tone === 'danger' ? ' danger' : ''}`}
      disabled={disabled}
      aria-label={ariaLabel ?? label}
      onClick={onClick}
    >
      <span className="editor-action-icon">{icon}</span>
      <span className="editor-action-label">{label}</span>
    </button>
  )
}
