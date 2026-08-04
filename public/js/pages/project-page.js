/**
 * Project shell: owns the camera, the loaded project data, and the
 * record/editor mode switch, plus the playback / export / onboarding
 * overlays and the toast.
 */
import { define, h, KvElement } from "../dom.js";
import { createCamera } from "../lib/camera.js";
import { buildClipsZip } from "../lib/clips-zip.js";
import { REMOVE_WATERMARK_LINK } from "../lib/entitlement.js";
import { clearExportMarker, markExportStarted, reportError } from "../lib/error-reporting.js";
import { exportProject } from "../lib/export/index.js";
import { exportSignature, loadMatchingExport, persistLastExport } from "../lib/export/last-export.js";
import { MediaElementFailureError } from "../lib/export/media-error.js";
import { wait } from "../lib/export/shared.js";
import { canShareFile, downloadBlob, isIosBrowser, projectFilename, shareFile } from "../lib/media.js";
import { loadProjectPage } from "../lib/project-actions.js";
import { createProject, setOnboardingDismissed } from "../lib/storage.js";
import { requestPersistentStorage } from "../lib/storage-space.js";
import { NEW_PROJECT_ID } from "../lib/types.js";
import { navigate } from "../router.js";
import { KvEditorScreen } from "../components/editor-screen.js";
import { KvExportOverlay } from "../components/export-overlay.js";
import { KvExportSheet } from "../components/export-sheet.js";
import { KvOnboardingOverlay } from "../components/onboarding-overlay.js";
import { KvPlaybackOverlay } from "../components/playback-overlay.js";
import { KvRecordScreen } from "../components/record-screen.js";
import { KvRestoreSheet } from "../components/sheets.js";
/** Resolve after the next animation frame (or a short timeout when rAF is busy). */
function waitForNextPaint() {
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done)
                return;
            done = true;
            resolve();
        };
        requestAnimationFrame(() => finish());
        window.setTimeout(finish, 50);
    });
}
export class KvProjectPage extends KvElement {
    camera = createCamera(() => this.#syncScreenProps());
    data = null;
    /** The projectId the current `data` was loaded for. */
    loadedForId = null;
    #projectId = '';
    mode = 'record';
    onboardingOpen = false;
    onboardingInitialized = false;
    playing = false;
    toast = null;
    toastTimer = 0;
    exportState = null;
    restoring = false;
    exportRun = 0;
    loadVersion = 0;
    /** In-flight share/save COUNT — the export sheet must not dismiss while > 0. */
    exportActionCount = 0;
    previewCanvas = null;
    bindPreviewCanvas = (element) => {
        this.previewCanvas = element;
    };
    ensureProjectPromise = null;
    /** Set once the lazy project persists (see original's lazy-create alias). */
    createdProjectId = null;
    els = {};
    set projectId(next) {
        this.#projectId = next;
        // The URL param changed in place (lazy create, or another project link).
        if (this.isConnected && next !== this.loadedForId) {
            this.load(next);
        }
    }
    get projectId() {
        return this.#projectId;
    }
    update() {
        this.syncView();
    }
    load(projectId) {
        this.loadedForId = projectId;
        const version = ++this.loadVersion;
        void loadProjectPage(projectId)
            .then((loaded) => {
            if (this.signal.aborted || version !== this.loadVersion)
                return;
            this.data = loaded;
            if (!this.onboardingInitialized) {
                this.onboardingInitialized = true;
                this.onboardingOpen = !loaded.onboardingDismissed;
            }
            this.syncView();
        })
            .catch((err) => {
            if (this.signal.aborted || version !== this.loadVersion)
                return;
            reportError(err, 'load-project');
            this.data = {
                project: null,
                clips: [],
                canUndo: false,
                onboardingDismissed: true,
                watermarkRemoved: false,
                storage: null,
                locationTaggingEnabled: false,
                error: err instanceof Error ? err.message : 'Could not load this project.',
            };
            this.syncView();
        });
    }
    /** The URL is the authority on which project this page shows (see the
     * original: right after lazy creation the path is already rewritten). */
    currentProjectId() {
        const match = window.location.pathname.match(/^\/project\/([^/]+)/);
        return match?.[1] ?? this.#projectId;
    }
    refresh = () => {
        this.load(this.currentProjectId());
    };
    showToast = (message, action) => {
        window.clearTimeout(this.toastTimer);
        this.toast = { message, ...action };
        this.syncView();
        this.toastTimer = window.setTimeout(() => {
            this.toast = null;
            this.syncView();
        }, 2600);
    };
    // Lazy creation: a "/project/new" project is persisted only when the
    // first clip finishes recording. Memoized so overlapping takes create
    // exactly one.
    ensureProjectId = () => {
        const project = this.data?.project;
        if (project && project.id !== NEW_PROJECT_ID)
            return Promise.resolve(project.id);
        this.ensureProjectPromise ??= (async () => {
            try {
                const created = await createProject();
                this.createdProjectId = created.id;
                // Their recordings should survive storage pressure.
                requestPersistentStorage();
                navigate(`/project/${created.id}`, { replace: true });
                return created.id;
            }
            catch (err) {
                // A failed creation must not poison later attempts.
                this.ensureProjectPromise = null;
                throw err;
            }
        })();
        return this.ensureProjectPromise;
    };
    setExportState(next) {
        this.exportState = next;
        this.syncView();
    }
    startExport(options) {
        if (!this.data)
            return;
        const clips = this.data.clips;
        const project = this.data.project;
        if (clips.length === 0)
            return;
        const runId = this.exportRun + 1;
        this.exportRun = runId;
        // Unlock an AudioContext from this tap: the realtime engine needs it
        // for audio mixing. WebCodecs ignores it.
        let audioContext;
        try {
            audioContext = new AudioContext();
            if (audioContext.state === 'suspended') {
                void audioContext.resume().catch(() => undefined);
            }
        }
        catch {
            audioContext = undefined;
        }
        const watermarked = !this.data.watermarkRemoved;
        const signature = exportSignature(clips, watermarked);
        // Stop camera/mic immediately rather than waiting on record-screen
        // unmount (iOS holds decoder slots past the first paints otherwise).
        this.camera.stop();
        this.setExportState({
            status: 'exporting',
            progress: 0,
            result: null,
            error: null,
            notice: null,
            watermarked,
        });
        // Long exports must survive the screen dimming.
        const wakeLockState = {
            current: null,
            released: false,
        };
        void navigator.wakeLock
            ?.request('screen')
            .then((sentinel) => {
            if (wakeLockState.released) {
                void sentinel.release().catch(() => undefined);
                return;
            }
            wakeLockState.current = sentinel;
        })
            .catch(() => undefined);
        void (async () => {
            try {
                // Unchanged project + a persisted last export = instant "ready".
                if (!options?.force && project) {
                    const recovered = await loadMatchingExport(project.id, signature).catch(() => null);
                    if (this.exportRun !== runId)
                        return;
                    if (recovered) {
                        this.setExportState({
                            status: 'ready',
                            progress: 1,
                            result: recovered.result,
                            error: null,
                            notice: 'Restored your last export — nothing changed since. Retry re-renders.',
                            watermarked: recovered.watermarked,
                        });
                        return;
                    }
                }
                // Export unmounts record/editor so camera + preview video release.
                // Wait two frames so those hardware decoder slots free first.
                await waitForNextPaint();
                await waitForNextPaint();
                // iOS WebKit frees hardware decoders asynchronously after stop().
                if (isIosBrowser())
                    await wait(400);
                if (this.exportRun !== runId)
                    return;
                markExportStarted({ clips: clips.length });
                const result = await exportProject(clips, {
                    audioContext,
                    watermark: watermarked,
                    getPreviewCanvas: () => this.previewCanvas,
                    onProgress: (ratio) => {
                        if (this.exportRun !== runId)
                            return;
                        if (this.exportState && this.exportState.status === 'exporting') {
                            this.exportState = { ...this.exportState, progress: ratio };
                            this.els.exportOverlay?.setProgress(ratio);
                        }
                    },
                });
                // Persist for recovery/instant reuse — in the background.
                if (project) {
                    void persistLastExport({ projectId: project.id, result, signature, watermarked }).catch(() => undefined);
                }
                if (this.exportRun !== runId)
                    return;
                this.setExportState({
                    status: 'ready',
                    progress: 1,
                    result,
                    error: null,
                    notice: null,
                    watermarked,
                });
            }
            catch (err) {
                reportError(err, 'export', {
                    clips: clips.length,
                    clipMimeTypes: clips.map((clip) => clip.mimeType),
                    clipSizes: clips.map((clip) => clip.blob.size),
                    mediaErrorCode: err instanceof MediaElementFailureError ? err.mediaErrorCode : undefined,
                    exportDetail: err && typeof err === 'object'
                        ? err.exportDetail
                        : undefined,
                });
                if (this.exportRun !== runId)
                    return;
                this.setExportState({
                    status: 'error',
                    progress: 0,
                    result: null,
                    error: err instanceof Error ? err.message : 'Export failed.',
                    notice: null,
                    watermarked,
                });
            }
            finally {
                // The export ended in this session (success or error) — it did not die.
                clearExportMarker();
                wakeLockState.released = true;
                void wakeLockState.current?.release().catch(() => undefined);
                wakeLockState.current = null;
                // The realtime engine closes the context it used; release the
                // unused tap-unlocked context when WebCodecs handled the export.
                if (audioContext && audioContext.state !== 'closed') {
                    void audioContext.close().catch(() => undefined);
                }
            }
        })();
    }
    closeExport = () => {
        this.exportRun += 1;
        this.setExportState(null);
    };
    setExportNotice(notice) {
        if (this.exportState) {
            this.exportState = { ...this.exportState, notice };
            this.syncView();
        }
    }
    beginExportAction() {
        this.exportActionCount += 1;
        this.syncView();
    }
    endExportAction = () => {
        this.exportActionCount = Math.max(0, this.exportActionCount - 1);
        this.syncView();
    };
    render() {
        this.els = {
            root: h('div', { className: 'screen project-screen' }),
            screen: null,
            screenTag: null,
            playback: null,
            exportOverlay: null,
            exportSheet: null,
            restoreSheet: null,
            onboarding: null,
            toastEl: null,
        };
        this.replaceChildren(this.els.root);
        this.signal.addEventListener('abort', () => {
            window.clearTimeout(this.toastTimer);
        });
        this.load(this.#projectId);
        this.syncView();
    }
    /** Callers guarantee loaded data with a project (screens never render
     * without one). */
    #screenProps() {
        const data = this.data;
        const project = data.project;
        const overlayOpen = this.playing || this.exportState !== null || this.onboardingOpen;
        return {
            project,
            clips: data.clips,
            canUndo: data.canUndo,
            camera: this.camera,
            storage: data.storage,
            locationTaggingEnabled: data.locationTaggingEnabled,
            interactionLocked: overlayOpen,
            ensureProjectId: this.ensureProjectId,
            onOpenEditor: () => {
                this.mode = 'editor';
                this.syncView();
            },
            onOpenCamera: () => {
                this.mode = 'record';
                this.syncView();
            },
            onOpenExport: () => this.startExport(),
            onPlay: () => {
                this.playing = true;
                this.syncView();
            },
            showToast: this.showToast,
            refresh: this.refresh,
        };
    }
    #syncScreenProps() {
        const els = this.els;
        if (els?.screen && this.data?.project) {
            els.screen.props = this.#screenProps();
            els.screen.update();
        }
    }
    syncView() {
        const els = this.els;
        if (!els?.root || !this.isConnected)
            return;
        const data = this.data;
        if (!data)
            return;
        const project = data.project;
        const clips = data.clips;
        if (!project || data.error) {
            if (data.error === 'Project not found') {
                queueMicrotask(() => navigate('/', { replace: true }));
                return;
            }
            els.screen = null;
            els.screenTag = null;
            els.root.replaceChildren(h('div', { className: 'error-banner' }, data.error ?? 'Project missing'), h('div', { style: { marginTop: '16px' } }, h('a', { className: 'btn btn-secondary', href: '/' }, 'Back home')));
            return;
        }
        // The rendered data must belong to the current route (browser history
        // between two projects changes the param in place). The lazy-create
        // transition ('new' → the freshly created id) is the same logical
        // project and keeps rendering, so the camera never unmounts mid-flow.
        const isLazyCreateAlias = project.id === NEW_PROJECT_ID &&
            (this.#projectId === NEW_PROJECT_ID || this.#projectId === this.createdProjectId);
        if (project.id !== this.#projectId && !isLazyCreateAlias) {
            els.screen = null;
            els.screenTag = null;
            els.root.replaceChildren();
            return;
        }
        const exporting = this.exportState?.status === 'exporting';
        const exportFilename = this.exportState?.result
            ? projectFilename(project.name, this.exportState.result.fileExtension)
            : null;
        // ---- record/editor screen (unmounted entirely while exporting) ----
        const wantedTag = exporting ? null : this.mode === 'record' ? 'kv-record-screen' : 'kv-editor-screen';
        if (wantedTag !== els.screenTag) {
            els.screen?.remove();
            els.screen = null;
            els.screenTag = wantedTag;
            if (wantedTag) {
                const screen = wantedTag === 'kv-record-screen' ? new KvRecordScreen() : new KvEditorScreen();
                screen.props = this.#screenProps();
                els.screen = screen;
                els.root.prepend(screen);
            }
        }
        else if (els.screen) {
            els.screen.props = this.#screenProps();
            els.screen.update();
        }
        // ---- playback overlay ----
        if (this.playing && !els.playback) {
            const playback = new KvPlaybackOverlay();
            playback.props = {
                clips,
                onClose: () => {
                    this.playing = false;
                    els.playback?.remove();
                    els.playback = null;
                    this.syncView();
                },
            };
            els.playback = playback;
            els.root.append(playback);
        }
        else if (!this.playing && els.playback) {
            els.playback.remove();
            els.playback = null;
        }
        // ---- export overlay (full-screen progress) ----
        if (exporting && !els.exportOverlay) {
            const overlay = new KvExportOverlay();
            overlay.props = {
                projectName: project.name,
                progress: this.exportState?.progress ?? 0,
                bindPreviewCanvas: this.bindPreviewCanvas,
            };
            els.exportOverlay = overlay;
            els.root.append(overlay);
        }
        else if (!exporting && els.exportOverlay) {
            els.exportOverlay.remove();
            els.exportOverlay = null;
        }
        // ---- export sheet (ready / error) ----
        const openExportState = this.exportState && this.exportState.status !== 'exporting' ? this.exportState : null;
        if (openExportState) {
            const exportState = openExportState;
            const sheetProps = {
                status: exportState.status,
                error: exportState.error,
                notice: exportState.notice,
                watermarked: exportState.watermarked,
                purchased: data.watermarkRemoved,
                busy: this.exportActionCount > 0,
                canShare: !!exportState.result &&
                    !!exportFilename &&
                    canShareFile(exportState.result.blob, exportFilename),
                fileExtension: exportState.result?.fileExtension ?? null,
                fileSizeBytes: exportState.result?.blob.size ?? null,
                onRemoveWatermark: () => {
                    window.open(REMOVE_WATERMARK_LINK, '_blank', 'noopener');
                },
                onRestorePurchase: () => {
                    this.restoring = true;
                    this.syncView();
                },
                onShare: () => {
                    const result = this.exportState?.result;
                    if (!result || !exportFilename)
                        return;
                    this.beginExportAction();
                    void shareFile(result.blob, exportFilename)
                        .then((outcome) => {
                        // A cancel is a routine user action — only confirm real shares.
                        if (outcome === 'shared')
                            this.setExportNotice('Shared!');
                    })
                        .catch(() => {
                        this.setExportNotice('Sharing failed — try Save instead.');
                    })
                        .finally(this.endExportAction);
                },
                onSave: () => {
                    const result = this.exportState?.result;
                    if (!result || !exportFilename)
                        return;
                    this.beginExportAction();
                    void downloadBlob(result.blob, exportFilename)
                        .then(() => {
                        this.setExportNotice('Saved — check your downloads.');
                    })
                        .catch(() => {
                        this.setExportNotice('Saving failed — try again.');
                    })
                        .finally(this.endExportAction);
                },
                onSaveClips: () => {
                    this.beginExportAction();
                    this.setExportNotice(`Zipping ${clips.length} clip${clips.length === 1 ? '' : 's'}… keep this open.`);
                    void buildClipsZip(clips)
                        .then((zip) => downloadBlob(zip, projectFilename(`${project.name} clips`, 'zip')))
                        .then(() => {
                        this.setExportNotice('Clips zipped — check your downloads.');
                    })
                        .catch(() => {
                        this.setExportNotice('Zipping failed — try again.');
                    })
                        .finally(this.endExportAction);
                },
                onRetry: () => this.startExport({ force: true }),
                onReExport: () => this.startExport({ force: true }),
                onClose: this.closeExport,
            };
            if (!els.exportSheet) {
                const sheet = new KvExportSheet();
                sheet.props = sheetProps;
                els.exportSheet = sheet;
                els.root.append(sheet);
            }
            else {
                els.exportSheet.props = sheetProps;
                els.exportSheet.update();
            }
        }
        else if (els.exportSheet) {
            els.exportSheet.remove();
            els.exportSheet = null;
        }
        // ---- restore-purchase sheet ----
        if (this.restoring && !els.restoreSheet) {
            const sheet = new KvRestoreSheet();
            sheet.props = {
                onClose: () => {
                    this.restoring = false;
                    this.syncView();
                },
                onRestored: () => {
                    this.restoring = false;
                    this.syncView();
                    this.showToast('Purchase restored — new exports are watermark-free');
                    this.refresh();
                },
            };
            els.restoreSheet = sheet;
            els.root.append(sheet);
        }
        else if (!this.restoring && els.restoreSheet) {
            els.restoreSheet.remove();
            els.restoreSheet = null;
        }
        // ---- onboarding overlay ----
        if (this.onboardingOpen && !els.onboarding) {
            const onboarding = new KvOnboardingOverlay();
            onboarding.props = {
                onDismiss: () => {
                    void (async () => {
                        await setOnboardingDismissed(true);
                        this.onboardingOpen = false;
                        this.syncView();
                    })();
                },
            };
            els.onboarding = onboarding;
            els.root.append(onboarding);
        }
        else if (!this.onboardingOpen && els.onboarding) {
            els.onboarding.remove();
            els.onboarding = null;
        }
        // ---- toast ----
        if (this.toast) {
            const toast = this.toast;
            const content = [h('span', null, toast.message)];
            if (toast.actionLabel && toast.onAction) {
                content.push(h('button', {
                    type: 'button',
                    onclick: () => {
                        window.clearTimeout(this.toastTimer);
                        const action = toast.onAction;
                        this.toast = null;
                        this.syncView();
                        action?.();
                    },
                }, toast.actionLabel));
            }
            if (!els.toastEl) {
                els.toastEl = h('div', { className: 'toast' });
                els.root.append(els.toastEl);
            }
            els.toastEl.replaceChildren(...content);
        }
        else if (els.toastEl) {
            els.toastEl.remove();
            els.toastEl = null;
        }
    }
}
define('kv-project-page', KvProjectPage);
