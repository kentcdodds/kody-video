/**
 * Home: fixed project slots (create/open/rename/backup/delete), storage
 * banner, install prompts, backup import, and the Plus upsell.
 */
import { define, h, KvElement } from "../dom.js";
import { reportError } from "../lib/error-reporting.js";
import { clearExportCache } from "../lib/export/export-cache.js";
import { dismissIosInstallHint, shouldShowIosInstallHint } from "../lib/install-hint.js";
import { canPromptInstall, promptInstall, subscribeInstallPrompt } from "../lib/install-prompt.js";
import { downloadBlob, shareOrDownload } from "../lib/media.js";
import { loadHomePage } from "../lib/project-actions.js";
import { BackupFormatError, importProjectBackup, parseProjectBackup, projectBackupFilename, serializeProject, } from "../lib/project-transfer.js";
import { deleteProject, getClipsForProject, renameProject } from "../lib/storage.js";
import { formatBytes, formatStoragePercent, requestPersistentStorage, storageSeverity, } from "../lib/storage-space.js";
import { FREE_PROJECTS, MAX_PROJECTS, NEW_PROJECT_ID, formatDuration } from "../lib/types.js";
import { navigate } from "../router.js";
import { brandMark } from "../components/brand-mark.js";
import { iconClose, iconLock, iconMore, iconPlus, iconShareIos } from "../components/icons.js";
import { KvConfirmSheet, KvHomeOptionsSheet, KvRenameSheet, KvRestoreSheet, KvUpsellSheet, } from "../components/sheets.js";
/** Android share targets get flaky well below this; bigger backups download. */
const SHARE_BACKUP_LIMIT_BYTES = 50 * 1024 * 1024;
/**
 * Last loaded home data, kept across mounts: navigating back to home renders
 * the slots immediately while a fresh load revalidates underneath.
 */
let lastHomeData = null;
export class KvHomePage extends KvElement {
    data = lastHomeData;
    error = null;
    busy = false;
    notice = null;
    importProgress = null;
    showInstallHint = shouldShowIosInstallHint();
    /** Prefetched when the options sheet opens so the Save-backup tap keeps
     * its user activation (Web Share needs it). */
    prefetchedClips = null;
    refreshVersion = 0;
    #main = null;
    #overlay = null;
    refresh = () => {
        const version = ++this.refreshVersion;
        void loadHomePage()
            .then((loaded) => {
            if (this.signal.aborted || version !== this.refreshVersion)
                return;
            lastHomeData = loaded;
            this.data = loaded;
            this.error = null;
            this.update();
        })
            .catch((err) => {
            if (this.signal.aborted || version !== this.refreshVersion)
                return;
            reportError(err, 'load-home');
            this.error = err instanceof Error ? err.message : 'Could not load your projects.';
            this.update();
        });
    };
    mounted() {
        this.#main = h('div', { style: { display: 'contents' } });
        // Sheets live outside the re-rendered main view so an open sheet's
        // input state survives background refreshes.
        this.#overlay = h('div', { style: { display: 'contents' } });
        this.replaceChildren(this.#main, this.#overlay);
        this.refresh();
        const unsubscribe = subscribeInstallPrompt(() => this.update());
        this.signal.addEventListener('abort', unsubscribe);
    }
    // Nothing is persisted until the first clip is recorded — backing out of
    // an untouched new project leaves no empty project behind.
    openNewProject = () => {
        navigate(`/project/${NEW_PROJECT_ID}`);
    };
    onClearExportCache = () => {
        this.busy = true;
        this.error = null;
        this.notice = null;
        this.update();
        void clearExportCache()
            .then((freedBytes) => {
            this.notice = `Cleared cached export files — freed ${formatBytes(freedBytes)}.`;
            this.refresh();
        })
            .catch((err) => {
            reportError(err, 'clear-export-cache');
            this.error =
                err instanceof Error ? err.message : 'Could not clear cached exports — try again.';
        })
            .finally(() => {
            this.busy = false;
            this.update();
        });
    };
    backupProject(project) {
        void (async () => {
            this.busy = true;
            this.error = null;
            this.notice = null;
            this.update();
            try {
                const prefetched = this.prefetchedClips;
                const clips = prefetched && prefetched.projectId === project.id
                    ? await prefetched.clips
                    : await getClipsForProject(project.id);
                if (clips.length === 0)
                    throw new Error('Nothing to back up — this project has no clips.');
                const backup = serializeProject(project, clips);
                const filename = projectBackupFilename(project.name);
                const sizeLabel = formatBytes(backup.size);
                // Android's share sheet fails (often silently) on very large files —
                // route big backups straight to a download instead.
                if (backup.size > SHARE_BACKUP_LIMIT_BYTES) {
                    await downloadBlob(backup, filename);
                    this.notice =
                        `Backup (${sizeLabel}) saved to your downloads — too large for the share sheet. ` +
                            'Open kody.video and tap Import to restore it.';
                }
                else {
                    const outcome = await shareOrDownload(backup, filename);
                    if (outcome !== 'cancelled') {
                        this.notice = `Backup (${sizeLabel}) saved. Open kody.video (or any Kody Video) and tap Import to restore it.`;
                    }
                }
            }
            catch (err) {
                this.error = err instanceof Error ? err.message : 'Could not create the backup';
            }
            finally {
                this.busy = false;
                this.update();
            }
        })();
    }
    importBackup(file) {
        void (async () => {
            this.busy = true;
            this.error = null;
            this.notice = null;
            this.importProgress = 'Reading backup…';
            this.update();
            try {
                const parsed = await parseProjectBackup(file);
                const project = await importProjectBackup(parsed, (done, total) => {
                    this.importProgress = `Importing clip ${Math.min(done + 1, total)} of ${total}…`;
                    this.update();
                });
                requestPersistentStorage();
                // Land directly in the imported project — unambiguous success.
                navigate(`/project/${project.id}`);
            }
            catch (err) {
                // Wrong/damaged file picked = expected user input, not a crash.
                if (!(err instanceof BackupFormatError))
                    reportError(err, 'import');
                this.error = err instanceof Error ? err.message : 'Could not import that file';
            }
            finally {
                this.importProgress = null;
                this.busy = false;
                this.update();
            }
        })();
    }
    #openSheet(element) {
        this.#overlay?.replaceChildren(element);
    }
    #closeSheet() {
        this.#overlay?.replaceChildren();
    }
    #openOptions(project) {
        this.prefetchedClips = { projectId: project.id, clips: getClipsForProject(project.id) };
        const sheet = new KvHomeOptionsSheet();
        sheet.props = {
            projectName: project.name,
            onClose: () => this.#closeSheet(),
            onOpen: () => {
                this.#closeSheet();
                navigate(`/project/${project.id}`);
            },
            onRename: () => this.#openRename(project),
            onBackup: () => {
                this.#closeSheet();
                this.backupProject(project);
            },
            onDelete: () => this.#openDelete(project),
        };
        this.#openSheet(sheet);
    }
    #openRename(project) {
        const sheet = new KvRenameSheet();
        sheet.props = {
            initialName: project.name,
            onClose: () => this.#closeSheet(),
            onSave: async (name) => {
                await renameProject(project.id, name);
                this.refresh();
            },
        };
        this.#openSheet(sheet);
    }
    #openDelete(project) {
        const sheet = new KvConfirmSheet();
        sheet.props = {
            title: 'Delete project?',
            message: `Delete “${project.name}” and all its clips? This can’t be undone.`,
            confirmLabel: 'Delete',
            onClose: () => this.#closeSheet(),
            onConfirm: async () => {
                await deleteProject(project.id);
                this.refresh();
            },
        };
        this.#openSheet(sheet);
    }
    #openUpsell() {
        const sheet = new KvUpsellSheet();
        sheet.props = {
            onClose: () => this.#closeSheet(),
            onRestore: () => this.#openRestore(),
        };
        this.#openSheet(sheet);
    }
    #openRestore() {
        const sheet = new KvRestoreSheet();
        sheet.props = {
            onClose: () => this.#closeSheet(),
            onRestored: () => {
                this.#closeSheet();
                this.notice = 'Kody Video Plus restored — all project slots are unlocked.';
                this.update();
                this.refresh();
            },
        };
        this.#openSheet(sheet);
    }
    render() {
        if (!this.#main)
            return;
        const data = this.data;
        if (!data) {
            // Load failure must not leave a silent blank screen.
            this.#main.replaceChildren(this.error
                ? h('div', { className: 'screen home-screen' }, h('div', { className: 'error-banner' }, this.error))
                : h('div', { className: 'screen home-screen' }));
            return;
        }
        const { projects, storage, exportCacheBytes, plus } = data;
        const installable = canPromptInstall();
        const slots = Array.from({ length: MAX_PROJECTS }, (_, index) => projects[index] ?? null);
        const projectLimit = plus ? MAX_PROJECTS : FREE_PROJECTS;
        const atCap = projects.length >= projectLimit;
        const severity = storage ? storageSeverity(storage.ratio) : 'ok';
        const oldestProject = projects[0] ?? null;
        const slotNodes = slots.map((project, index) => {
            if (project) {
                return h('article', {
                    className: project.posterThumb
                        ? 'project-slot filled has-poster'
                        : 'project-slot filled',
                }, project.posterThumb
                    ? h('img', {
                        className: 'slot-poster',
                        src: this.blobUrl(project.posterThumb),
                        alt: '',
                        'aria-hidden': 'true',
                        draggable: false,
                    })
                    : null, h('div', { className: 'slot-fade', 'aria-hidden': 'true' }), h('a', { className: 'slot-open', href: `/project/${project.id}` }, h('span', { className: 'slot-number' }, `Slot ${index + 1}`), h('strong', null, project.name), h('small', null, `${project.clipCount} clip${project.clipCount === 1 ? '' : 's'} · ${formatDuration(project.durationMs)}`)), h('button', {
                    type: 'button',
                    className: 'slot-options',
                    'aria-label': `Options for ${project.name}`,
                    onclick: () => this.#openOptions(project),
                }, iconMore()));
            }
            if (index < projectLimit) {
                return h('button', {
                    type: 'button',
                    className: 'project-slot empty',
                    disabled: this.busy,
                    onclick: this.openNewProject,
                }, h('span', { className: 'slot-plus', 'aria-hidden': 'true' }, iconPlus(26)), h('strong', null, 'New project'), h('small', null, `Slot ${index + 1}`));
            }
            return h('button', {
                type: 'button',
                className: 'project-slot empty locked',
                onclick: () => this.#openUpsell(),
            }, h('span', { className: 'slot-plus', 'aria-hidden': 'true' }, iconLock(22)), h('strong', null, 'Plus slot'), h('small', null, 'Unlock with Kody Video Plus'));
        });
        const importInput = h('input', {
            type: 'file',
            accept: '.kodyvideo,application/octet-stream',
            className: 'visually-hidden',
            disabled: this.busy,
            onchange: (event) => {
                const input = event.currentTarget;
                const file = input.files?.[0];
                input.value = '';
                if (file)
                    this.importBackup(file);
            },
        });
        this.#main.replaceChildren(h('div', { className: 'screen home-screen' }, h('div', { className: 'home-hero' }, h('div', { className: 'home-hero-art', 'aria-hidden': 'true' }, brandMark({ size: 96, className: 'brand-hero-art', variant: 'camera' })), h('h1', { className: 'brand' }, 'Kody ', h('span', null, 'Video')), h('p', { className: 'lede' }, 'Hold to record. Tap Go to share.')), this.error ? h('div', { className: 'error-banner' }, this.error) : null, this.notice ? h('p', { className: 'home-notice' }, this.notice) : null, this.importProgress
            ? h('p', { className: 'home-notice', role: 'status', 'aria-live': 'polite' }, `${this.importProgress} Keep this tab open.`)
            : null, storage && severity !== 'ok'
            ? h('div', {
                className: `storage-banner${severity === 'critical' ? ' is-critical' : ''}`,
                role: 'alert',
            }, h('strong', null, `Device storage ${formatStoragePercent(storage.ratio)} full` +
                (severity === 'critical' ? ' — recordings may start failing' : '')), h('span', null, `${formatBytes(storage.usedBytes)} of ${formatBytes(storage.quotaBytes)} used.` +
                (oldestProject
                    ? ` Free space fast: delete an old project (⋯ on “${oldestProject.name}”, then Delete).`
                    : ' Free space by clearing other site data or files on this device.')), exportCacheBytes > 0
                ? h('button', {
                    type: 'button',
                    className: 'btn btn-secondary storage-banner-action',
                    disabled: this.busy,
                    onclick: this.onClearExportCache,
                }, `Clear cached exports (${formatBytes(exportCacheBytes)})`)
                : null)
            : null, this.showInstallHint
            ? h('div', { className: 'home-install-hint' }, h('span', { className: 'install-hint-icon', 'aria-hidden': 'true' }, iconShareIos(18)), h('span', null, 'Install Kody Video: tap ', h('strong', null, 'Share'), ', then ', h('strong', null, 'Add to Home Screen'), ' — full screen, and your clips are safer from Safari’s storage cleanup.'), h('button', {
                type: 'button',
                className: 'install-hint-dismiss',
                'aria-label': 'Dismiss install tip',
                onclick: () => {
                    dismissIosInstallHint();
                    this.showInstallHint = false;
                    this.update();
                },
            }, iconClose(16)))
            : null, h('section', { className: 'project-slots', 'aria-label': 'Kody Video projects' }, slotNodes), h('p', { className: 'home-privacy' }, 'Clips stay on this phone until you share.', storage
            ? ` ${formatBytes(storage.usedBytes)} of ${formatBytes(storage.quotaBytes)} used.`
            : '', ' ', h('a', { href: '/about' }, 'About'), installable
            ? [
                ' · ',
                h('button', {
                    type: 'button',
                    className: 'link-button',
                    onclick: () => {
                        void promptInstall();
                    },
                }, 'Install app'),
            ]
            : null), h('div', { className: 'home-footer' }, atCap && !plus
            ? h('button', { type: 'button', className: 'btn btn-primary', onclick: () => this.#openUpsell() }, 'Get more projects')
            : h('button', {
                type: 'button',
                className: 'btn btn-primary',
                disabled: this.busy || atCap,
                onclick: this.openNewProject,
            }, atCap ? `Limit ${MAX_PROJECTS}` : 'New project'), h('label', {
            className: `btn btn-ghost home-import${this.busy ? ' is-disabled' : ''}`,
            onclick: (event) => {
                if (!atCap)
                    return;
                event.preventDefault();
                if (!plus) {
                    this.#openUpsell();
                    return;
                }
                this.error = `Project limit reached (${MAX_PROJECTS}). Delete a project before importing.`;
                this.update();
            },
        }, 'Import', importInput))));
    }
}
define('kv-home-page', KvHomePage);
