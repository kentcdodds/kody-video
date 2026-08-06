import type { Handle } from 'remix/ui'
import { on } from 'remix/ui'
import { reportError } from '../lib/error-reporting'
import {
  BackupFormatError,
  dataTransferHasFiles,
  importKodyVideoBackupFile,
  kodyVideoBackupFilesFromList,
} from '../lib/project-transfer'
import { navigate } from '../router'

/**
 * App-wide drop target for `.kodyvideo` backups. OS file drags never expose
 * names until drop, so we highlight whenever files are dragged in and only
 * import a matching backup. Other file types are ignored.
 */
export function BackupDropOverlay(handle: Handle) {
  let dragDepth = 0
  let hovering = false
  let importing = false
  let progress: string | null = null
  let error: string | null = null

  const setHovering = (next: boolean) => {
    if (hovering === next) return
    hovering = next
    void handle.update()
  }

  const resetDrag = () => {
    dragDepth = 0
    setHovering(false)
  }

  const importBackup = (file: File) => {
    if (importing) return
    void (async () => {
      importing = true
      error = null
      progress = 'Reading backup…'
      void handle.update()
      try {
        const project = await importKodyVideoBackupFile(file, (done, total) => {
          progress = `Importing clip ${Math.min(done + 1, total)} of ${total}…`
          void handle.update()
        })
        navigate(`/project/${project.id}`)
      } catch (err) {
        if (!(err instanceof BackupFormatError)) reportError(err, 'import-drop')
        error = err instanceof Error ? err.message : 'Could not import that file'
      } finally {
        progress = null
        importing = false
        void handle.update()
      }
    })()
  }

  const onDragEnter = (event: DragEvent) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepth += 1
    setHovering(true)
  }

  const onDragOver = (event: DragEvent) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    setHovering(true)
  }

  const onDragLeave = (event: DragEvent) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) setHovering(false)
  }

  const onDrop = (event: DragEvent) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    resetDrag()
    const file = kodyVideoBackupFilesFromList(event.dataTransfer?.files)[0]
    if (!file) return
    importBackup(file)
  }

  window.addEventListener('dragenter', onDragEnter, { signal: handle.signal })
  window.addEventListener('dragover', onDragOver, { signal: handle.signal })
  window.addEventListener('dragleave', onDragLeave, { signal: handle.signal })
  window.addEventListener('drop', onDrop, { signal: handle.signal })

  return () => (
    <>
      {hovering && !importing ? (
        <div className="backup-drop-overlay" role="status" aria-live="polite">
          <strong>Drop to import</strong>
          <p>
            Restore a <code>.kodyvideo</code> backup as a new project.
          </p>
        </div>
      ) : null}
      {importing && progress ? (
        <div className="backup-drop-overlay is-importing" role="status" aria-live="polite">
          <strong>Importing backup</strong>
          <p>
            {progress} Keep this tab open.
          </p>
        </div>
      ) : null}
      {error && !importing ? (
        <div className="backup-drop-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="link-button"
            mix={on('click', () => {
              error = null
              void handle.update()
            })}
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </>
  )
}
