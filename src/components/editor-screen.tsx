import { useState } from 'react'
import {
  duplicateSelectedClip,
  moveSelectedClip,
  removeClip,
  trimClip,
  undoLastDelete,
} from '../lib/project-actions'
import { effectiveDurationMs, formatDuration, type ClipId, type ClipRecord, type Project } from '../lib/types'
import { EditorClipPreview } from './editor-clip-preview'
import { Timeline } from './timeline'
import { TrimSheet } from './trim-sheet'
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
    <div className="editor-screen">
      <div className="editor-top">
        <button type="button" className="btn-icon" aria-label="Back to camera" onClick={onOpenCamera}>
          ←
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
          ▶
        </button>
      </div>

      <div className="editor-stage">
        {selected ? (
          <EditorClipPreview clip={selected} />
        ) : (
          <div className="editor-empty-preview">Select a clip in the timeline</div>
        )}
      </div>

      <div className="editor-panel">
        <Timeline
          clips={clips}
          selectedClipId={resolvedSelectedId}
          onSelect={setSelectedClipId}
        />

        <div className="editor-actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!selected || selectedIndex <= 0}
            aria-label="Move clip left"
            onClick={() => {
              if (!resolvedSelectedId) return
              void moveSelectedClip(project.id, resolvedSelectedId, 'left').then(refresh)
            }}
          >
            ◀
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!selected}
            aria-label="Duplicate clip"
            onClick={() => {
              if (!resolvedSelectedId) return
              void duplicateSelectedClip(resolvedSelectedId).then((copy) => {
                setSelectedClipId(copy.id)
                refresh()
              })
            }}
          >
            ⧉
          </button>
          <button
            type="button"
            className="btn btn-primary trim-action"
            disabled={!selected}
            onClick={() => setTrimming(true)}
          >
            Trim
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!selected}
            aria-label="Delete clip"
            onClick={handleDelete}
          >
            🗑
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!selected || selectedIndex >= clips.length - 1}
            aria-label="Move clip right"
            onClick={() => {
              if (!resolvedSelectedId) return
              void moveSelectedClip(project.id, resolvedSelectedId, 'right').then(refresh)
            }}
          >
            ▶
          </button>
        </div>

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

      {trimming && selected ? (
        <TrimSheet
          key={selected.id}
          clip={selected}
          onClose={() => setTrimming(false)}
          onSave={async (trimStartMs, trimEndMs) => {
            await trimClip(selected.id, trimStartMs, trimEndMs)
            refresh()
          }}
        />
      ) : null}
    </div>
  )
}
