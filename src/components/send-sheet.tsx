import type { Handle } from 'remix/ui'
import { on, ref } from 'remix/ui'
import { attachSheetModal } from '../lib/sheet-modal'
import { reportError } from '../lib/error-reporting'
import { formatRoomCode, type SyncPhase } from '../lib/sync-protocol'
import { createSyncRoom, httpSyncSignaling, SyncSignalError } from '../lib/sync-signaling'
import { sendBackupToPeer, SyncTransferError } from '../lib/sync-peer'
import { getClipsForProject, getProject, getProjectAudio } from '../lib/storage'
import { projectBackupFilename, serializeProject } from '../lib/project-transfer'
import { pairingHint, pairingHref } from '../lib/pairing-href'
import { formatBytes } from '../lib/storage-space'
import { SyncQr } from './sync-qr'

interface SendSheetProps {
  projectId: string
  projectName: string
  onClose: () => void
  onBackupInstead: () => void
}

function phaseCopy(phase: SyncPhase, error: string | null): string {
  switch (phase) {
    case 'creating':
      return 'Starting a send room…'
    case 'waiting':
      return `Open ${pairingHint('receive')} on the other device and scan or type this code. Keep both screens open.`
    case 'connecting':
      return 'Connecting to the other device…'
    case 'transferring':
      return 'Sending the project. Keep both screens open.'
    case 'importing':
      return 'Sending the project. Keep both screens open.'
    case 'done':
      return 'Sent. The other device is importing it as a new project.'
    case 'failed':
      return error ?? 'Could not send this project.'
    default: {
      const _exhaustive: never = phase
      return _exhaustive
    }
  }
}

/** Plus: push this project to another device over WebRTC (STUN, no cloud copy). */
export function SendSheet(handle: Handle<SendSheetProps>) {
  let phase: SyncPhase = 'creating'
  let code: string | null = null
  let error: string | null = null
  let progress = ''
  let copied = false
  const abort = new AbortController()

  handle.signal.addEventListener('abort', () => abort.abort(), { once: true })

  const fail = (err: unknown) => {
    if (abort.signal.aborted) return
    if (err instanceof DOMException && err.name === 'AbortError') return
    if (!(err instanceof SyncSignalError) && !(err instanceof SyncTransferError)) {
      reportError(err, 'sync-send')
    }
    error = err instanceof Error ? err.message : 'Could not send this project.'
    phase = 'failed'
    void handle.update()
  }

  void (async () => {
    try {
      const room = await createSyncRoom()
      if (abort.signal.aborted) return
      code = room.code
      phase = 'waiting'
      void handle.update()

      const [clips, audio, project] = await Promise.all([
        getClipsForProject(handle.props.projectId),
        getProjectAudio(handle.props.projectId),
        getProject(handle.props.projectId),
      ])
      if (abort.signal.aborted) return
      if (clips.length === 0) throw new Error('Nothing to send — this project has no clips.')
      if (!project) throw new Error('That project is gone.')
      const backup = serializeProject(project, clips, audio)
      const filename = projectBackupFilename(project.name)

      await sendBackupToPeer(
        httpSyncSignaling(room.code),
        backup,
        filename,
        abort.signal,
        (sent, total) => {
          if (abort.signal.aborted) return
          progress = `${formatBytes(sent)} of ${formatBytes(total)}`
          void handle.update()
        },
        () => {
          if (abort.signal.aborted) return
          phase = 'transferring'
          void handle.update()
        },
      )
      if (abort.signal.aborted) return
      phase = 'done'
      void handle.update()
    } catch (err) {
      fail(err)
    }
  })()

  const receiveHref = () => pairingHref('receive', code)

  return () => {
    const { projectName, onClose, onBackupInstead } = handle.props
    const inFlight = () => phase !== 'done' && phase !== 'failed'
    return (
      <>
        <div
          className="sheet-backdrop"
          mix={on('click', () => {
            if (inFlight()) return
            onClose()
          })}
        />
        <div
          className="sheet send-sheet"
          role="dialog"
          aria-modal="true"
          aria-label={`Send ${projectName}`}
          mix={ref((node, signal) =>
            attachSheetModal(node as HTMLElement, signal, {
              onDismiss: () => handle.props.onClose(),
              busy: inFlight,
            }),
          )}
        >
          <h3>Send to another device</h3>
          <p className={phase === 'failed' ? 'sheet-lede is-error' : 'sheet-lede muted'}>
            {phaseCopy(phase, error)}
          </p>
          {code && phase !== 'failed' ? (
            <div className="sync-code-block">
              <p className="sync-code" aria-label={`Send code ${formatRoomCode(code)}`}>
                {formatRoomCode(code)}
              </p>
              <SyncQr href={receiveHref()} />
              <button
                type="button"
                className="link-button"
                mix={on('click', () => {
                  void navigator.clipboard?.writeText(receiveHref()).then(
                    () => {
                      copied = true
                      void handle.update()
                    },
                    () => undefined,
                  )
                })}
              >
                {copied ? 'Link copied' : 'Copy receive link'}
              </button>
            </div>
          ) : null}
          {progress && (phase === 'transferring' || phase === 'connecting') ? (
            <p className="export-percent" role="status">
              {progress}
            </p>
          ) : null}
          <div className="sheet-actions">
            {phase === 'failed' ? (
              <button
                type="button"
                className="btn btn-primary"
                mix={on('click', () => onBackupInstead())}
              >
                Save backup instead
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-ghost"
              mix={on('click', () => {
                abort.abort()
                onClose()
              })}
            >
              {phase === 'done' ? 'Done' : 'Cancel'}
            </button>
          </div>
        </div>
      </>
    )
  }
}
