import type { Handle } from 'remix/ui'
import { on } from 'remix/ui'
import { IconBack } from '../components/icons'
import { BrandMark } from '../components/brand-mark'
import { reportError } from '../lib/error-reporting'
import { BackupFormatError, importKodyVideoBackupFile } from '../lib/project-transfer'
import { ProjectLimitError } from '../lib/storage'
import { formatBytes } from '../lib/storage-space'
import { formatRoomCode, normalizeRoomCode, type SyncPhase } from '../lib/sync-protocol'
import { httpSyncSignaling, SyncSignalError } from '../lib/sync-signaling'
import { receiveBackupFromPeer, SyncTransferError } from '../lib/sync-peer'
import { navigate } from '../router'

interface ReceivePageProps {
  code?: string
}

function phaseCopy(phase: SyncPhase, error: string | null, hasCode: boolean): string {
  switch (phase) {
    case 'creating':
      return hasCode
        ? 'Waiting for the sender. Keep this screen open.'
        : 'Type the code from the other device, or open the link / QR it showed.'
    case 'waiting':
      return 'Waiting for the sender. Keep this screen open.'
    case 'connecting':
      return 'Connecting…'
    case 'transferring':
      return 'Receiving the project. Keep this screen open.'
    case 'importing':
      return 'Saving the project on this device…'
    case 'done':
      return 'Project received.'
    case 'failed':
      return error ?? 'Could not receive a project.'
    default: {
      const _exhaustive: never = phase
      return _exhaustive
    }
  }
}

/** Free: accept a Plus send and import it as a new project. */
export function ReceivePage(handle: Handle<ReceivePageProps>) {
  let typed = handle.props.code ?? ''
  let phase: SyncPhase = handle.props.code ? 'waiting' : 'creating'
  let error: string | null = null
  let progress = ''
  const abort = new AbortController()

  handle.signal.addEventListener('abort', () => abort.abort(), { once: true })

  const fail = (err: unknown) => {
    if (abort.signal.aborted) return
    if (err instanceof DOMException && err.name === 'AbortError') return
    if (
      !(err instanceof SyncSignalError) &&
      !(err instanceof SyncTransferError) &&
      !(err instanceof BackupFormatError) &&
      !(err instanceof ProjectLimitError)
    ) {
      reportError(err, 'sync-receive')
    }
    error = err instanceof Error ? err.message : 'Could not receive a project.'
    phase = 'failed'
    void handle.update()
  }

  const receive = (rawCode: string) => {
    const code = normalizeRoomCode(rawCode)
    if (!code) {
      error = 'That is not a valid send code.'
      phase = 'failed'
      void handle.update()
      return
    }
    phase = 'waiting'
    error = null
    progress = ''
    void handle.update()
    void (async () => {
      try {
        const received = await receiveBackupFromPeer(
          httpSyncSignaling(code),
          abort.signal,
          (receivedBytes, totalBytes) => {
            if (abort.signal.aborted) return
            progress = `${formatBytes(receivedBytes)} of ${formatBytes(totalBytes)}`
            void handle.update()
          },
          () => {
            if (abort.signal.aborted) return
            phase = 'transferring'
            void handle.update()
          },
        )
        if (abort.signal.aborted) return
        phase = 'importing'
        void handle.update()
        const file = new File([received.blob], received.filename, {
          type: 'application/octet-stream',
        })
        const project = await importKodyVideoBackupFile(file)
        if (abort.signal.aborted) return
        phase = 'done'
        void handle.update()
        navigate(`/project/${project.id}`)
      } catch (err) {
        fail(err)
      }
    })()
  }

  if (handle.props.code) receive(handle.props.code)

  return () => (
    <div className="screen about-screen receive-screen">
      <div className="about-top">
        <a href="/" className="btn-icon" aria-label="Back to projects">
          <IconBack />
        </a>
        <strong>Receive</strong>
        <span className="about-top-spacer" aria-hidden="true" />
      </div>
      <div className="about-body">
        <div className="about-hero" aria-hidden="true">
          <BrandMark size={96} className="brand-hero-art" variant="share" />
        </div>
        <h1>Receive a project</h1>
        <p className="muted">{phaseCopy(phase, error, Boolean(handle.props.code))}</p>
        {handle.props.code && phase !== 'failed' && phase !== 'creating' ? (
          <p className="sync-code receive-code">{formatRoomCode(handle.props.code)}</p>
        ) : null}
        {!handle.props.code && phase === 'creating' ? (
          <form
            className="receive-form"
            mix={on('submit', (event) => {
              event.preventDefault()
              receive(typed)
            })}
          >
            <div className="field">
              <label htmlFor="receive-code">Send code</label>
              <input
                id="receive-code"
                type="text"
                inputMode="text"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="off"
                placeholder="AB3-K9Q"
                value={typed}
                mix={on('input', (event) => {
                  typed = (event.currentTarget as HTMLInputElement).value
                  void handle.update()
                })}
              />
            </div>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!normalizeRoomCode(typed)}
            >
              Receive
            </button>
          </form>
        ) : null}
        {progress && (phase === 'transferring' || phase === 'importing') ? (
          <p className="export-percent" role="status">
            {progress}
          </p>
        ) : null}
        {phase === 'failed' ? (
          <div className="sheet-actions receive-actions">
            <a className="btn btn-ghost" href="/receive">
              Try another code
            </a>
            <a className="btn btn-primary" href="/about">
              Import a backup
            </a>
          </div>
        ) : null}
      </div>
    </div>
  )
}
