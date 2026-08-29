import type { Handle } from 'remix/ui'
import { on } from 'remix/ui'
import * as popover from 'remix/ui/popover'
import { BlobImage } from '../components/blob-image'
import { BrandMark } from '../components/brand-mark'
import { ConfirmSheet } from '../components/confirm-sheet'
import { HomeOptionsSheet } from '../components/home-options-sheet'
import { SendSheet } from '../components/send-sheet'
import {
  IconClose,
  IconDownload,
  IconInfo,
  IconLock,
  IconMore,
  IconPlus,
  IconShareIos,
} from '../components/icons'
import { TourCard } from '../components/tour-card'
import { UpsellSheet } from '../components/upsell-sheet'
import { RestoreSheet } from '../components/restore-sheet'
import { RenameSheet } from '../components/rename-sheet'
import { StorageMeter } from '../components/storage-meter'
import { downloadBlob, shareOrDownload } from '../lib/media'
import { loadHomePage, type HomeLoaderData, type ProjectSummary } from '../lib/project-actions'
import { projectBackupFilename, serializeProject } from '../lib/project-transfer'
import {
  deleteProject,
  getClipsForProject,
  getProjectAudio,
  renameProject,
  setTourCardDismissed,
  setVideoQuality,
} from '../lib/storage'
import { clearExportCache } from '../lib/export/export-cache'
import { reportError } from '../lib/error-reporting'
import { canPromptInstall, promptInstall, subscribeInstallPrompt } from '../lib/install-prompt'
import { dismissIosInstallHint, shouldShowIosInstallHint } from '../lib/install-hint'
import {
  dismissShowcaseBanner,
  isShowcaseBannerDismissed,
  showcaseForHostname,
} from '../lib/showcase'
import { navigate } from '../router'
import { formatBytes, formatStoragePercent, storageSeverity } from '../lib/storage-space'
import {
  FREE_PROJECTS,
  MAX_PROJECTS,
  NEW_PROJECT_ID,
  formatDuration,
  type ClipRecord,
  type ProjectAudioRecord,
} from '../lib/types'

/** Android share targets get flaky well below this; bigger backups download. */
const SHARE_BACKUP_LIMIT_BYTES = 50 * 1024 * 1024

/** The pre-custom-domain deployment; nudge people to migrate to kody.video. */
function isLegacyOrigin(): boolean {
  return location.hostname === 'kody-video.pages.dev'
}

/**
 * Last loaded home data, kept across mounts: navigating back to home renders
 * the slots immediately (like React Router's blocking loader used to) while
 * a fresh load revalidates underneath.
 */
let lastHomeData: HomeLoaderData | null = null

export function HomePage(handle: Handle) {
  let data: HomeLoaderData | null = lastHomeData
  let error: string | null = null
  let menuProject: ProjectSummary | null = null
  let renaming: ProjectSummary | null = null
  let deleting: ProjectSummary | null = null
  let busy = false
  let notice: string | null = null
  let showInstallHint = shouldShowIosInstallHint()
  let upselling = false
  let restoring = false
  let sending: ProjectSummary | null = null
  let installPopoverOpen = false
  const showcase = showcaseForHostname(location.hostname)
  let showShowcaseBanner = showcase !== null && !isShowcaseBannerDismissed()
  // Prefetched when the options sheet opens so the Save-backup tap keeps its
  // user activation (Web Share needs it; an IndexedDB read can outlive it).
  let prefetchedClips: {
    projectId: string
    clips: Promise<ClipRecord[]>
    audio: Promise<ProjectAudioRecord | undefined>
  } | null = null

  /** Monotonic request id: an older in-flight load (e.g. the mount load
   * resolving after a delete's refresh) must never overwrite newer state. */
  let refreshVersion = 0
  const refresh = () => {
    const version = ++refreshVersion
    void loadHomePage()
      .then((loaded) => {
        if (handle.signal.aborted || version !== refreshVersion) return
        lastHomeData = loaded
        data = loaded
        error = null
        void handle.update()
      })
      .catch((err) => {
        if (handle.signal.aborted || version !== refreshVersion) return
        reportError(err, 'load-home')
        error = err instanceof Error ? err.message : 'Could not load your projects.'
        void handle.update()
      })
  }
  refresh()

  const unsubscribeInstall = subscribeInstallPrompt(() => void handle.update())
  handle.signal.addEventListener('abort', unsubscribeInstall)

  // Rotating (or resizing across the phone-width breakpoint) swaps who
  // paints the hero: portrait mobile shows the static #boot-hero over a
  // same-size spacer (LCP), landscape/desktop render the real in-app hero
  // inside the two-pane layout. The swap is a render-time decision, so both
  // media flips must re-render.
  const heroMediaQueries = [
    window.matchMedia('(orientation: landscape)'),
    window.matchMedia('(max-width: 719px)'),
  ]
  const onHeroMediaChange = () => void handle.update()
  for (const media of heroMediaQueries) {
    media.addEventListener('change', onHeroMediaChange)
  }
  handle.signal.addEventListener('abort', () => {
    for (const media of heroMediaQueries) {
      media.removeEventListener('change', onHeroMediaChange)
    }
  })

  // Nothing is persisted until the first clip is recorded — backing out of
  // an untouched new project leaves no empty project behind.
  const openNewProject = () => {
    navigate(`/project/${NEW_PROJECT_ID}`)
  }

  // Cached export files (the recoverable last export + scratch) can hold
  // gigabytes — when storage runs hot, the fix must be one tap away.
  const onClearExportCache = () => {
    busy = true
    error = null
    notice = null
    void handle.update()
    void clearExportCache()
      .then((freedBytes) => {
        notice = `Cleared cached export files — freed ${formatBytes(freedBytes)}.`
        refresh()
      })
      .catch((err) => {
        reportError(err, 'clear-export-cache')
        error = err instanceof Error ? err.message : 'Could not clear cached exports — try again.'
      })
      .finally(() => {
        busy = false
        void handle.update()
      })
  }

  const backupProject = (project: ProjectSummary) => {
    void (async () => {
      busy = true
      error = null
      notice = null
      void handle.update()
      try {
        const prefetched = prefetchedClips
        const usePrefetch = prefetched !== null && prefetched.projectId === project.id
        const clips = usePrefetch
          ? await prefetched.clips
          : await getClipsForProject(project.id)
        if (clips.length === 0) throw new Error('Nothing to back up — this project has no clips.')
        const audio = usePrefetch
          ? await prefetched.audio
          : await getProjectAudio(project.id)
        const backup = serializeProject(project, clips, audio)
        const filename = projectBackupFilename(project.name)
        const sizeLabel = formatBytes(backup.size)
        // Android's share sheet fails (often silently) on very large files —
        // route big backups straight to a download instead.
        if (backup.size > SHARE_BACKUP_LIMIT_BYTES) {
          await downloadBlob(backup, filename)
          notice =
            `Backup (${sizeLabel}) saved to your downloads — too large for the share sheet. ` +
            'Open kody.video → About → Import a backup to restore it.'
        } else {
          const outcome = await shareOrDownload(backup, filename)
          if (outcome !== 'cancelled') {
            notice = `Backup (${sizeLabel}) saved. Open kody.video (or any Kody Video) → About → Import a backup to restore it.`
          }
        }
      } catch (err) {
        error = err instanceof Error ? err.message : 'Could not create the backup'
      } finally {
        busy = false
        void handle.update()
      }
    })()
  }

  return () => {
    if (!data) {
      // Load failure must not leave a silent blank screen.
      return error ? (
        <div className="screen home-screen">
          <div className="error-banner">{error}</div>
        </div>
      ) : null
    }
    const { projects, storage, exportCacheBytes, plus } = data
    const videoQuality = data.videoQuality ?? 'standard'
    const installable = canPromptInstall()

    const slots = Array.from({ length: MAX_PROJECTS }, (_, index) => projects[index] ?? null)
    const projectLimit = plus ? MAX_PROJECTS : FREE_PROJECTS
    const severity = storage ? storageSeverity(storage.ratio) : 'ok'
    const oldestProject = projects[0] ?? null

    return (
      <div className="screen home-screen">
        {/* Corner buttons: 44px tap targets clear of other controls — the
            old footer text links were too small and crowded for thumbs. */}
        {installable ? (
          // A bare download glyph is ambiguous — tapping it opens a small
          // anchored popover that says what installing gets you, with the
          // actual Install action behind a clearly labeled button.
          <popover.Context>
            <button
              type="button"
              className="btn-icon home-corner home-corner-left"
              aria-label="Install app"
              mix={[
                popover.anchor({ placement: 'bottom-start', offsetY: 8 }),
                popover.focusOnHide(),
                on('click', () => {
                  // Explicit toggle (with closeOnAnchorClick: false below):
                  // a second tap on the corner button dismisses the popover.
                  installPopoverOpen = !installPopoverOpen
                  void handle.update()
                }),
              ]}
            >
              <IconDownload />
            </button>
            <div
              className="install-popover"
              role="dialog"
              aria-label="Install Kody Video"
              mix={popover.surface({
                open: installPopoverOpen,
                // The anchor's own click handler owns toggling; letting the
                // surface also request close on anchor taps double-handles
                // the same click.
                closeOnAnchorClick: false,
                onHide: () => {
                  installPopoverOpen = false
                  void handle.update()
                },
              })}
            >
              <strong>Install Kody Video</strong>
              <p>
                Full screen, works offline, and your clips are safer from browser storage cleanup.
              </p>
              <button
                type="button"
                className="btn btn-primary install-popover-action"
                mix={[
                  popover.focusOnShow(),
                  on('click', (event) => {
                    // Hide the native popover synchronously — its toggle
                    // events release the scroll lock and restore focus —
                    // because consuming the one-shot install event unmounts
                    // this subtree without ever firing those events. Then
                    // prompt in the same tick: Chromium wants prompt()
                    // during the tap's transient user activation.
                    ;(event.currentTarget as HTMLElement).closest<HTMLElement>('[popover]')?.hidePopover()
                    installPopoverOpen = false
                    void promptInstall()
                    void handle.update()
                  }),
                ]}
              >
                Install
              </button>
            </div>
          </popover.Context>
        ) : null}
        <a
          className="btn-icon home-corner home-corner-right"
          href="/about"
          aria-label="About Kody Video"
        >
          <IconInfo />
        </a>

        {/* On portrait mobile, the visible brand/LCP hero lives in
            index.html (#boot-hero) so first paint is not gated on JS — this
            block is a layout spacer there. Desktop and landscape viewports
            hide #boot-hero and show this (it moves into the two-pane
            layout's left column). */}
        <div
          className="home-hero home-hero-spacer"
          aria-hidden={
            typeof window !== 'undefined' &&
            window.matchMedia('(max-width: 719px) and (orientation: portrait)').matches
          }
        >
          <div className="home-hero-art">
            <BrandMark
              size={96}
              className="brand-hero-art"
              variant="camera"
              priority={
                typeof window !== 'undefined' &&
                window.matchMedia('(max-width: 719px) and (orientation: portrait)').matches
              }
            />
          </div>
          <h1 className="brand">
            Kody <span>Video</span>
          </h1>
          <p className="lede">Hold to record. Tap Go to share.</p>
        </div>

        <div className="home-main">
          {isLegacyOrigin() ? (
            <div className="home-migrate">
              <strong>Kody Video has moved to <a href="https://kody.video">kody.video</a>.</strong>{' '}
              Projects live in this browser per-site, so use ⋯ → Save backup here, then import them
              over there (About → Import a backup). This address keeps working but won&rsquo;t get
              updates.
            </div>
          ) : null}

          {showcase && showShowcaseBanner ? (
            <div className="home-migrate home-showcase" role="note">
              <span>
                <strong>
                  This is the {showcase.edition} showcase — the real app lives at{' '}
                  <a href="https://kody.video">kody.video</a>.
                </strong>{' '}
                Projects stay in this browser per-site, so record over there. Curious how this
                edition came to be? Read the agent&rsquo;s analysis in{' '}
                <a href={showcase.prUrl} target="_blank" rel="noreferrer noopener">
                  PR #{showcase.prNumber}
                </a>
                .
              </span>
              <button
                type="button"
                className="install-hint-dismiss"
                aria-label="Dismiss showcase note"
                mix={on('click', () => {
                  dismissShowcaseBanner()
                  showShowcaseBanner = false
                  void handle.update()
                })}
              >
                <IconClose size={16} />
              </button>
            </div>
          ) : null}

          {error ? <div className="error-banner">{error}</div> : null}
          {notice ? <p className="home-notice">{notice}</p> : null}

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
                  : ' Free space by clearing other site data or files on this device.'}{' '}
                New clips can also use less space — lower video quality below or on{' '}
                <a href="/about#video-quality">About</a>.
              </span>
              {exportCacheBytes > 0 ? (
                <button
                  type="button"
                  className="btn btn-secondary storage-banner-action"
                  disabled={busy}
                  mix={on('click', onClearExportCache)}
                >
                  Clear cached exports ({formatBytes(exportCacheBytes)})
                </button>
              ) : null}
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
                mix={on('click', () => {
                  dismissIosInstallHint()
                  showInstallHint = false
                  void handle.update()
                })}
              >
                <IconClose size={16} />
              </button>
            </div>
          ) : null}

          {projects.length === 0 && !data.tourCardDismissed ? (
            <TourCard
              onDismiss={() => {
                // Mutate the loaded data (it is also the module-level
                // lastHomeData cache) so a remount before the async persist
                // lands doesn't resurrect the card.
                data!.tourCardDismissed = true
                void setTourCardDismissed(true)
                void handle.update()
              }}
            />
          ) : null}

          <section className="project-slots" aria-label="Kody Video projects">
            {slots.map((project, index) =>
              project ? (
                <article
                  key={project.id}
                  className={
                    project.posterThumb ? 'project-slot filled has-poster' : 'project-slot filled'
                  }
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
                  <a className="slot-open" href={`/project/${project.id}`}>
                    <span className="slot-number">Slot {index + 1}</span>
                    <strong>{project.name}</strong>
                    <small>
                      {project.clipCount} clip{project.clipCount === 1 ? '' : 's'} ·{' '}
                      {formatDuration(project.durationMs)}
                    </small>
                  </a>
                  <button
                    type="button"
                    className="slot-options"
                    aria-label={`Options for ${project.name}`}
                    mix={on('click', () => {
                      prefetchedClips = {
                        projectId: project.id,
                        clips: getClipsForProject(project.id),
                        audio: getProjectAudio(project.id),
                      }
                      menuProject = project
                      void handle.update()
                    })}
                  >
                    <IconMore />
                  </button>
                </article>
              ) : index < projectLimit ? (
                <button
                  key={`empty-${index}`}
                  type="button"
                  className="project-slot empty"
                  disabled={busy}
                  mix={on('click', openNewProject)}
                >
                  <span className="slot-plus" aria-hidden="true">
                    <IconPlus size={26} />
                  </span>
                  <strong>New project</strong>
                  <small>{`Slot ${index + 1}`}</small>
                </button>
              ) : (
                <button
                  key={`locked-${index}`}
                  type="button"
                  className="project-slot empty locked"
                  mix={on('click', () => {
                    upselling = true
                    void handle.update()
                  })}
                >
                  <span className="slot-plus" aria-hidden="true">
                    <IconLock size={22} />
                  </span>
                  <strong>Plus slot</strong>
                  <small>Unlock with Kody Video Plus</small>
                </button>
              ),
            )}
          </section>

          <p className="home-privacy">
            <span>
              Clips stay on this phone until you share.{' '}
              <a href="/receive">Receive a project</a>
            </span>
            {storage ? (
              <StorageMeter
                storage={storage}
                videoQuality={videoQuality}
                plus={plus}
                onVideoQualityChange={(next) => {
                  // Invalidate the mount/revalidation load so it cannot land
                  // after this pick and snap the control back to the stale
                  // snapshot. Persist lives here so a failed write can
                  // refresh from disk.
                  data = { ...data!, videoQuality: next }
                  lastHomeData = data
                  const pickVersion = ++refreshVersion
                  void handle.update()
                  void setVideoQuality(next).catch((err) => {
                    reportError(err, 'video-quality')
                    if (refreshVersion === pickVersion) refresh()
                  })
                }}
                onUpsell={() => {
                  upselling = true
                  void handle.update()
                }}
              />
            ) : null}
          </p>
        </div>

        {menuProject ? (
          <HomeOptionsSheet
            projectName={menuProject.name}
            onClose={() => {
              menuProject = null
              void handle.update()
            }}
            onOpen={() => {
              const id = menuProject!.id
              menuProject = null
              void handle.update()
              navigate(`/project/${id}`)
            }}
            onRename={() => {
              renaming = menuProject
              menuProject = null
              void handle.update()
            }}
            onBackup={() => {
              const project = menuProject!
              menuProject = null
              void handle.update()
              backupProject(project)
            }}
            onSend={() => {
              const project = menuProject!
              menuProject = null
              if (!plus) {
                upselling = true
              } else {
                sending = project
              }
              void handle.update()
            }}
            onDelete={() => {
              deleting = menuProject
              menuProject = null
              void handle.update()
            }}
          />
        ) : null}

        {renaming ? (
          <RenameSheet
            key={renaming.id}
            initialName={renaming.name}
            onClose={() => {
              renaming = null
              void handle.update()
            }}
            onSave={async (name) => {
              await renameProject(renaming!.id, name)
              refresh()
            }}
          />
        ) : null}

        {deleting ? (
          <ConfirmSheet
            title="Delete project?"
            message={`Delete “${deleting.name}” and all its clips? This can’t be undone.`}
            confirmLabel="Delete"
            onClose={() => {
              deleting = null
              void handle.update()
            }}
            onConfirm={async () => {
              await deleteProject(deleting!.id)
              refresh()
            }}
          />
        ) : null}

        {sending ? (
          <SendSheet
            key={sending.id}
            projectId={sending.id}
            projectName={sending.name}
            onClose={() => {
              sending = null
              void handle.update()
            }}
            onBackupInstead={() => {
              const project = sending!
              sending = null
              void handle.update()
              backupProject(project)
            }}
          />
        ) : null}

        {upselling ? (
          <UpsellSheet
            onClose={() => {
              upselling = false
              void handle.update()
            }}
            onRestore={() => {
              upselling = false
              restoring = true
              void handle.update()
            }}
          />
        ) : null}

        {restoring ? (
          <RestoreSheet
            onClose={() => {
              restoring = false
              void handle.update()
            }}
            onRestored={() => {
              restoring = false
              notice = 'Kody Video Plus restored — all project slots are unlocked.'
              void handle.update()
              refresh()
            }}
          />
        ) : null}
      </div>
    )
  }
}
