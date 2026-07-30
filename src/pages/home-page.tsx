import { startTransition, useRef, useState, useSyncExternalStore } from 'react'
import { Link, useLoaderData, useNavigate, useRevalidator } from 'react-router-dom'
import { BlobImage } from '../components/blob-image'
import { BrandMark } from '../components/brand-mark'
import { ConfirmSheet } from '../components/confirm-sheet'
import { HomeOptionsSheet } from '../components/home-options-sheet'
import { IconClose, IconMore, IconPlus, IconShareIos } from '../components/icons'
import { RenameSheet } from '../components/rename-sheet'
import { downloadBlob, shareOrDownload } from '../lib/media'
import { loadHomePage, type HomeLoaderData, type ProjectSummary } from '../lib/project-actions'
import {
  BackupFormatError,
  importProjectBackup,
  parseProjectBackup,
  projectBackupFilename,
  serializeProject,
} from '../lib/project-transfer'
import { createProject, deleteProject, getClipsForProject, renameProject } from '../lib/storage'
import { reportError } from '../lib/error-reporting'
import { canPromptInstall, promptInstall, subscribeInstallPrompt } from '../lib/install-prompt'
import { dismissIosInstallHint, shouldShowIosInstallHint } from '../lib/install-hint'
import {
  formatBytes,
  formatStoragePercent,
  requestPersistentStorage,
  storageSeverity,
} from '../lib/storage-space'
import { MAX_PROJECTS, formatDuration, type ClipRecord } from '../lib/types'

/** Android share targets get flaky well below this; bigger backups download. */
const SHARE_BACKUP_LIMIT_BYTES = 50 * 1024 * 1024

/** The pre-custom-domain deployment; nudge people to migrate to kody.video. */
function isLegacyOrigin(): boolean {
  return location.hostname === 'kody-video.pages.dev'
}

export async function homeLoader(): Promise<HomeLoaderData> {
  return loadHomePage()
}

export function HomePage() {
  const { projects, storage } = useLoaderData() as HomeLoaderData
  const revalidator = useRevalidator()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [menuProject, setMenuProject] = useState<ProjectSummary | null>(null)
  const [renaming, setRenaming] = useState<ProjectSummary | null>(null)
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [importProgress, setImportProgress] = useState<string | null>(null)
  const [showInstallHint, setShowInstallHint] = useState(shouldShowIosInstallHint)
  // Prefetched when the options sheet opens so the Save-backup tap keeps its
  // user activation (Web Share needs it; an IndexedDB read can outlive it).
  const prefetchedClipsRef = useRef<{ projectId: string; clips: Promise<ClipRecord[]> } | null>(
    null,
  )

  const refresh = () => {
    startTransition(() => {
      void revalidator.revalidate()
    })
  }

  const installable = useSyncExternalStore(subscribeInstallPrompt, canPromptInstall)

  const createAndOpenProject = () => {
    void (async () => {
      setBusy(true)
      setError(null)
      try {
        const project = await createProject()
        // Their recordings should survive storage pressure.
        requestPersistentStorage()
        navigate(`/project/${project.id}`)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not create project')
      } finally {
        setBusy(false)
      }
    })()
  }

  const backupProject = (project: ProjectSummary) => {
    void (async () => {
      setBusy(true)
      setError(null)
      setNotice(null)
      try {
        const prefetched = prefetchedClipsRef.current
        const clips =
          prefetched && prefetched.projectId === project.id
            ? await prefetched.clips
            : await getClipsForProject(project.id)
        if (clips.length === 0) throw new Error('Nothing to back up — this project has no clips.')
        const backup = serializeProject(project, clips)
        const filename = projectBackupFilename(project.name)
        const sizeLabel = formatBytes(backup.size)
        // Android's share sheet fails (often silently) on very large files —
        // route big backups straight to a download instead.
        if (backup.size > SHARE_BACKUP_LIMIT_BYTES) {
          await downloadBlob(backup, filename)
          setNotice(
            `Backup (${sizeLabel}) saved to your downloads — too large for the share sheet. ` +
              'Open kody.video and tap Import to restore it.',
          )
        } else {
          const outcome = await shareOrDownload(backup, filename)
          if (outcome !== 'cancelled') {
            setNotice(
              `Backup (${sizeLabel}) saved. Open kody.video (or any Kody Video) and tap Import to restore it.`,
            )
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not create the backup')
      } finally {
        setBusy(false)
      }
    })()
  }

  const importBackup = (file: File) => {
    void (async () => {
      setBusy(true)
      setError(null)
      setNotice(null)
      setImportProgress('Reading backup…')
      try {
        const parsed = await parseProjectBackup(file)
        const project = await importProjectBackup(parsed, (done, total) => {
          setImportProgress(`Importing clip ${Math.min(done + 1, total)} of ${total}…`)
        })
        requestPersistentStorage()
        // Land directly in the imported project — unambiguous success, and
        // no dependence on the list revalidating behind the scenes.
        navigate(`/project/${project.id}`)
      } catch (err) {
        // Wrong/damaged file picked = expected user input, not a crash.
        if (!(err instanceof BackupFormatError)) reportError(err, 'import')
        setError(err instanceof Error ? err.message : 'Could not import that file')
      } finally {
        setImportProgress(null)
        setBusy(false)
      }
    })()
  }

  const slots = Array.from({ length: MAX_PROJECTS }, (_, index) => projects[index] ?? null)
  const atCap = projects.length >= MAX_PROJECTS
  const severity = storage ? storageSeverity(storage.ratio) : 'ok'
  const oldestProject = projects[0] ?? null

  return (
    <div className="screen home-screen">
      <div className="home-hero">
        <div className="home-hero-art" aria-hidden="true">
          <BrandMark size={96} className="brand-hero-art" variant="camera" />
        </div>
        <h1 className="brand">
          Kody <span>Video</span>
        </h1>
        <p className="lede">Hold to record. Tap Go to share.</p>
      </div>

      {isLegacyOrigin() ? (
        <div className="home-migrate">
          <strong>Kody Video has moved to <a href="https://kody.video">kody.video</a>.</strong>{' '}
          Projects live in this browser per-site, so use ⋯ → Save backup here, then Import them
          over there. This address keeps working but won&rsquo;t get updates.
        </div>
      ) : null}

      {error ? <div className="error-banner">{error}</div> : null}
      {notice ? <p className="home-notice">{notice}</p> : null}
      {importProgress ? (
        <p className="home-notice" role="status" aria-live="polite">
          {importProgress} Keep this tab open.
        </p>
      ) : null}

      {storage && severity !== 'ok' ? (
        <div
          className={`storage-banner${severity === 'critical' ? ' is-critical' : ''}`}
          role="alert"
        >
          <strong>
            Device storage {formatStoragePercent(storage.ratio)} full
            {severity === 'critical' ? ' — recordings may start failing' : ''}
          </strong>
          <span>
            {formatBytes(storage.usedBytes)} of {formatBytes(storage.quotaBytes)} used.
            {oldestProject
              ? ` Free space fast: delete an old project (⋯ on “${oldestProject.name}”, then Delete).`
              : ' Free space by clearing other site data or files on this device.'}
          </span>
        </div>
      ) : null}

      {showInstallHint ? (
        <div className="home-install-hint">
          <span className="install-hint-icon" aria-hidden="true">
            <IconShareIos size={18} />
          </span>
          <span>
            Install Kody Video: tap <strong>Share</strong>, then{' '}
            <strong>Add to Home Screen</strong> — full screen, and your clips are safer from
            Safari&rsquo;s storage cleanup.
          </span>
          <button
            type="button"
            className="install-hint-dismiss"
            aria-label="Dismiss install tip"
            onClick={() => {
              dismissIosInstallHint()
              setShowInstallHint(false)
            }}
          >
            <IconClose size={16} />
          </button>
        </div>
      ) : null}

      <section className="project-slots" aria-label="Kody Video projects">
        {slots.map((project, index) =>
          project ? (
            <article
              key={project.id}
              className={project.posterThumb ? 'project-slot filled has-poster' : 'project-slot filled'}
            >
              {project.posterThumb ? (
                <BlobImage
                  blob={project.posterThumb}
                  className="slot-poster"
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                />
              ) : null}
              <div className="slot-fade" aria-hidden="true" />
              <Link className="slot-open" to={`/project/${project.id}`}>
                <span className="slot-number">Slot {index + 1}</span>
                <strong>{project.name}</strong>
                <small>
                  {project.clipCount} clip{project.clipCount === 1 ? '' : 's'} ·{' '}
                  {formatDuration(project.durationMs)}
                </small>
              </Link>
              <button
                type="button"
                className="slot-options"
                aria-label={`Options for ${project.name}`}
                onClick={() => {
                  prefetchedClipsRef.current = {
                    projectId: project.id,
                    clips: getClipsForProject(project.id),
                  }
                  setMenuProject(project)
                }}
              >
                <IconMore />
              </button>
            </article>
          ) : (
            <button
              key={`empty-${index}`}
              type="button"
              className="project-slot empty"
              disabled={busy || atCap}
              onClick={createAndOpenProject}
            >
              <span className="slot-plus" aria-hidden="true">
                <IconPlus size={26} />
              </span>
              <strong>New project</strong>
              <small>{atCap ? 'Six-project limit' : `Slot ${index + 1}`}</small>
            </button>
          ),
        )}
      </section>

      <p className="home-privacy">
        Clips stay on this phone until you share.
        {storage ? ` ${formatBytes(storage.usedBytes)} of ${formatBytes(storage.quotaBytes)} used.` : ''}{' '}
        <Link to="/about">About</Link>
        {installable ? (
          <>
            {' · '}
            <button
              type="button"
              className="link-button"
              onClick={() => {
                void promptInstall()
              }}
            >
              Install app
            </button>
          </>
        ) : null}
      </p>

      <div className="home-footer">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || atCap}
          onClick={createAndOpenProject}
        >
          {atCap ? `Limit ${MAX_PROJECTS}` : 'New project'}
        </button>
        <label
          className={`btn btn-ghost home-import${busy ? ' is-disabled' : ''}`}
          onClick={(event) => {
            if (atCap) {
              event.preventDefault()
              setError(
                `Project limit reached (${MAX_PROJECTS}). Delete a project before importing.`,
              )
            }
          }}
        >
          Import
          <input
            type="file"
            accept=".kodyvideo,application/octet-stream"
            className="visually-hidden"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) importBackup(file)
            }}
          />
        </label>
      </div>

      {menuProject ? (
        <HomeOptionsSheet
          projectName={menuProject.name}
          onClose={() => setMenuProject(null)}
          onOpen={() => {
            const id = menuProject.id
            setMenuProject(null)
            navigate(`/project/${id}`)
          }}
          onRename={() => {
            setRenaming(menuProject)
            setMenuProject(null)
          }}
          onBackup={() => {
            const project = menuProject
            setMenuProject(null)
            backupProject(project)
          }}
          onDelete={() => {
            setDeleting(menuProject)
            setMenuProject(null)
          }}
        />
      ) : null}

      {renaming ? (
        <RenameSheet
          key={renaming.id}
          initialName={renaming.name}
          onClose={() => setRenaming(null)}
          onSave={async (name) => {
            await renameProject(renaming.id, name)
            refresh()
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmSheet
          title="Delete project?"
          message={`Delete “${deleting.name}” and all its clips? This can’t be undone.`}
          confirmLabel="Delete"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await deleteProject(deleting.id)
            refresh()
          }}
        />
      ) : null}
    </div>
  )
}
