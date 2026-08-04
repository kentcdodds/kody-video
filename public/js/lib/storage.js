import { openDB } from "./idb.js";
import { removeExportEntry } from "./export/opfs.js";
import { FREE_PROJECTS, MAX_PROJECTS, newId, } from "./types.js";
export const DB_NAME = 'kody-video';
const DB_VERSION = 1;
let dbPromise = null;
/**
 * Finish an explicit idb transaction without leaking AbortError.
 *
 * `tx.done` is created eagerly and rejects as soon as any request fails —
 * often before a later `await tx.done` runs. Awaiting the requests and
 * `tx.done` together keeps that rejection in the same catch path (see
 * jakearchibald/idb#320). Otherwise Sentry sees `AbortError: AbortError`
 * via `unhandledrejection` as a twin of the real store error.
 */
async function completeTransaction(ops, tx) {
    await Promise.all([...ops, tx.done]);
}
export function getDb() {
    if (!dbPromise) {
        dbPromise = openDB(DB_NAME, DB_VERSION, {
            upgrade(db) {
                const projects = db.createObjectStore('projects', { keyPath: 'id' });
                projects.createIndex('by-updated', 'updatedAt');
                const clips = db.createObjectStore('clips', { keyPath: 'id' });
                clips.createIndex('by-project', 'projectId');
                db.createObjectStore('undo', { keyPath: 'clip.projectId' });
                db.createObjectStore('meta', { keyPath: 'key' });
            },
        });
    }
    return dbPromise;
}
/** Test helper: close open connections and clear the module-level DB handle. */
export async function __resetDbForTests() {
    if (dbPromise) {
        const db = await dbPromise.catch(() => null);
        db?.close();
    }
    dbPromise = null;
    await new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase(DB_NAME);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error ?? new Error('Failed to delete database'));
        req.onblocked = () => resolve();
    });
}
export async function getSettings() {
    const db = await getDb();
    const existing = await db.get('meta', 'settings');
    const defaults = {
        key: 'settings',
        maxProjects: MAX_PROJECTS,
        lastOpenedProjectId: null,
        onboardingDismissed: false,
    };
    const settings = existing ? { ...defaults, ...existing } : defaults;
    if (!existing || existing.onboardingDismissed === undefined) {
        await db.put('meta', settings);
    }
    return settings;
}
export async function setLastOpenedProjectId(projectId) {
    const db = await getDb();
    const settings = await getSettings();
    await db.put('meta', { ...settings, lastOpenedProjectId: projectId });
}
export async function setOnboardingDismissed(onboardingDismissed) {
    const db = await getDb();
    const settings = await getSettings();
    await db.put('meta', { ...settings, onboardingDismissed });
}
export async function setLocationTaggingEnabled(locationTaggingEnabled) {
    const db = await getDb();
    const settings = await getSettings();
    await db.put('meta', { ...settings, locationTaggingEnabled });
}
export async function listProjects() {
    const db = await getDb();
    const projects = await db.getAllFromIndex('projects', 'by-updated');
    return projects.reverse();
}
export async function getProject(id) {
    const db = await getDb();
    return db.get('projects', id);
}
export async function createProject(name) {
    const db = await getDb();
    const existing = await listProjects();
    const settings = await getSettings();
    if (existing.length >= settings.maxProjects) {
        throw new Error(`Project limit reached (${settings.maxProjects}). Delete a project to create another.`);
    }
    // Free tier includes one project; the one-time Kody Video Plus purchase
    // (the watermark unlock) raises the cap to maxProjects. Enforced here so
    // every creation path (record, import) hits the same gate.
    if (settings.watermarkRemoved !== true && existing.length >= FREE_PROJECTS) {
        throw new Error('The free plan includes 1 project — Kody Video Plus unlocks 6 (and removes the watermark).');
    }
    const now = Date.now();
    const project = {
        id: newId('proj'),
        name: name?.trim() || defaultProjectName(existing.length + 1),
        createdAt: now,
        updatedAt: now,
        clipIds: [],
    };
    await db.put('projects', project);
    await setLastOpenedProjectId(project.id);
    return project;
}
function defaultProjectName(n) {
    return `Project ${n}`;
}
export async function renameProject(id, name) {
    const db = await getDb();
    const project = await db.get('projects', id);
    if (!project)
        throw new Error('Project not found');
    const trimmed = name.trim();
    if (!trimmed)
        throw new Error('Name cannot be empty');
    const updated = { ...project, name: trimmed, updatedAt: Date.now() };
    await db.put('projects', updated);
    return updated;
}
export async function deleteProject(id) {
    const db = await getDb();
    const project = await db.get('projects', id);
    if (!project)
        return;
    const tx = db.transaction(['projects', 'clips', 'undo', 'meta'], 'readwrite');
    // Read meta before queueing writes so a failed delete cannot reject while
    // we are still awaiting get — that would reintroduce the AbortError leak.
    const settings = await tx.objectStore('meta').get('settings');
    const clips = tx.objectStore('clips');
    const ops = [
        ...project.clipIds.map((clipId) => clips.delete(clipId)),
        tx.objectStore('undo').delete(id),
        tx.objectStore('projects').delete(id),
    ];
    const dropsCachedExport = settings?.lastExport?.projectId === id;
    if (settings && (settings.lastOpenedProjectId === id || dropsCachedExport)) {
        ops.push(tx.objectStore('meta').put({
            ...settings,
            lastOpenedProjectId: settings.lastOpenedProjectId === id ? null : settings.lastOpenedProjectId,
            lastExport: dropsCachedExport ? undefined : settings.lastExport,
        }));
    }
    await completeTransaction(ops, tx);
    // The cached export can be ~1GB — deleting a project must actually free
    // its space, not just its clips. Best-effort, after the commit.
    if (dropsCachedExport && settings?.lastExport) {
        await removeExportEntry(settings.lastExport.opfsName).catch(() => undefined);
    }
}
export async function touchProject(id) {
    const db = await getDb();
    const project = await db.get('projects', id);
    if (!project)
        return;
    await db.put('projects', { ...project, updatedAt: Date.now() });
}
export async function getClipsForProject(projectId) {
    const db = await getDb();
    const project = await db.get('projects', projectId);
    if (!project)
        return [];
    const clips = [];
    for (const clipId of project.clipIds) {
        const clip = await db.get('clips', clipId);
        if (clip)
            clips.push(clip);
    }
    return clips;
}
export async function getClip(id) {
    const db = await getDb();
    return db.get('clips', id);
}
export async function getClipMetasForProject(projectId) {
    const clips = await getClipsForProject(projectId);
    return clips.map(toMeta);
}
function toMeta(clip) {
    const { blob: _blob, thumbs: _thumbs, ...meta } = clip;
    return meta;
}
/**
 * Copy blob bytes into a fresh Blob before IndexedDB persistence.
 * MediaRecorder / File-backed blobs can fail Chromium's object-store write
 * with UnknownError ("Error preparing Blob/File data to be stored…") when
 * the original backing store is ephemeral or already released.
 *
 * Prefer `mimeType` when the source Blob's type is empty so Safari does not
 * later reject an `application/octet-stream` object URL at export.
 */
export async function toStoredBlob(blob, mimeType) {
    const buffer = await blob.arrayBuffer();
    return new Blob([buffer], { type: blob.type || mimeType || 'application/octet-stream' });
}
export async function addClip(input) {
    const db = await getDb();
    // Materialize before opening the transaction — awaiting inside a tx lets
    // IndexedDB auto-commit and abort subsequent puts. Re-read the project
    // inside the tx so overlapping saves cannot clobber fresher clipIds.
    const durableBlob = await toStoredBlob(input.blob, input.mimeType);
    const now = Date.now();
    const clip = {
        id: newId('clip'),
        projectId: input.projectId,
        blob: durableBlob,
        mimeType: input.mimeType,
        durationMs: input.durationMs,
        trimStartMs: 0,
        trimEndMs: input.durationMs,
        createdAt: input.createdAt ?? now,
        width: input.width,
        height: input.height,
        lat: input.lat,
        lng: input.lng,
        locationAccuracyM: input.locationAccuracyM,
    };
    const tx = db.transaction(['clips', 'projects'], 'readwrite');
    const project = await tx.objectStore('projects').get(input.projectId);
    if (!project) {
        await tx.done.catch(() => undefined);
        throw new Error('Project not found');
    }
    await completeTransaction([
        tx.objectStore('clips').put(clip),
        tx.objectStore('projects').put({
            ...project,
            clipIds: [...project.clipIds, clip.id],
            updatedAt: now,
        }),
    ], tx);
    return clip;
}
export async function updateClipThumbs(clipId, input) {
    const db = await getDb();
    const [thumbs, poster] = await Promise.all([
        Promise.all(input.thumbs.map((thumb) => toStoredBlob(thumb))),
        toStoredBlob(input.poster),
    ]);
    // Read + merge + write in one transaction so a concurrent trim/delete can
    // never be clobbered by a stale snapshot of the clip record.
    const tx = db.transaction('clips', 'readwrite');
    const clip = await tx.store.get(clipId);
    if (!clip) {
        await tx.done;
        return;
    }
    const updated = {
        ...clip,
        thumbs,
        poster,
        thumbWidth: input.thumbWidth,
        thumbHeight: input.thumbHeight,
        width: clip.width ?? input.videoWidth,
        height: clip.height ?? input.videoHeight,
    };
    await completeTransaction([tx.store.put(updated)], tx);
}
export async function updateClipTrim(clipId, trimStartMs, trimEndMs) {
    const db = await getDb();
    const clip = await db.get('clips', clipId);
    if (!clip)
        throw new Error('Clip not found');
    const start = Math.max(0, Math.min(trimStartMs, clip.durationMs));
    const end = Math.max(start, Math.min(trimEndMs, clip.durationMs));
    const updated = { ...clip, trimStartMs: start, trimEndMs: end };
    await db.put('clips', updated);
    await touchProject(clip.projectId);
    return toMeta(updated);
}
export async function reorderClips(projectId, clipIds) {
    const db = await getDb();
    const project = await db.get('projects', projectId);
    if (!project)
        throw new Error('Project not found');
    const set = new Set(project.clipIds);
    if (clipIds.length !== project.clipIds.length || clipIds.some((id) => !set.has(id))) {
        throw new Error('Invalid clip order');
    }
    const updated = { ...project, clipIds, updatedAt: Date.now() };
    await db.put('projects', updated);
    return updated;
}
export async function moveClip(projectId, clipId, direction) {
    const project = await getProject(projectId);
    if (!project)
        throw new Error('Project not found');
    const index = project.clipIds.indexOf(clipId);
    if (index < 0)
        throw new Error('Clip not in project');
    const next = [...project.clipIds];
    const swapWith = direction === 'left' ? index - 1 : index + 1;
    if (swapWith < 0 || swapWith >= next.length)
        return project;
    [next[index], next[swapWith]] = [next[swapWith], next[index]];
    return reorderClips(projectId, next);
}
export async function duplicateClip(clipId) {
    const db = await getDb();
    const source = await db.get('clips', clipId);
    if (!source)
        throw new Error('Clip not found');
    const now = Date.now();
    const [blob, thumbs, poster] = await Promise.all([
        toStoredBlob(source.blob, source.mimeType),
        source.thumbs
            ? Promise.all(source.thumbs.map((thumb) => toStoredBlob(thumb)))
            : Promise.resolve(undefined),
        source.poster ? toStoredBlob(source.poster) : Promise.resolve(undefined),
    ]);
    const tx = db.transaction(['clips', 'projects'], 'readwrite');
    const clip = await tx.objectStore('clips').get(clipId);
    const project = clip
        ? await tx.objectStore('projects').get(clip.projectId)
        : undefined;
    if (!clip || !project) {
        await tx.done.catch(() => undefined);
        throw new Error(!clip ? 'Clip not found' : 'Project not found');
    }
    const index = project.clipIds.indexOf(clipId);
    if (index < 0) {
        await tx.done.catch(() => undefined);
        throw new Error('Clip not in project');
    }
    const copy = {
        ...clip,
        id: newId('clip'),
        createdAt: now,
        blob,
        thumbs,
        poster,
    };
    const clipIds = [...project.clipIds];
    clipIds.splice(index + 1, 0, copy.id);
    await completeTransaction([
        tx.objectStore('clips').put(copy),
        tx.objectStore('projects').put({
            ...project,
            clipIds,
            updatedAt: now,
        }),
    ], tx);
    return copy;
}
export async function deleteClip(clipId) {
    const db = await getDb();
    const clip = await db.get('clips', clipId);
    if (!clip)
        return null;
    const project = await db.get('projects', clip.projectId);
    if (!project)
        return null;
    const index = project.clipIds.indexOf(clipId);
    if (index < 0)
        return null;
    const snapshot = {
        clip,
        index,
        deletedAt: Date.now(),
    };
    const clipIds = project.clipIds.filter((id) => id !== clipId);
    const tx = db.transaction(['clips', 'projects', 'undo'], 'readwrite');
    await completeTransaction([
        tx.objectStore('clips').delete(clipId),
        tx.objectStore('projects').put({
            ...project,
            clipIds,
            updatedAt: Date.now(),
        }),
        tx.objectStore('undo').put(snapshot),
    ], tx);
    return snapshot;
}
export async function getUndoSnapshot(projectId) {
    const db = await getDb();
    return db.get('undo', projectId);
}
export async function undoDeleteLastClip(projectId) {
    const db = await getDb();
    const snapshot = await db.get('undo', projectId);
    if (!snapshot)
        return null;
    const project = await db.get('projects', projectId);
    if (!project)
        return null;
    const clipIds = [...project.clipIds];
    const insertAt = Math.min(snapshot.index, clipIds.length);
    clipIds.splice(insertAt, 0, snapshot.clip.id);
    const tx = db.transaction(['clips', 'projects', 'undo'], 'readwrite');
    await completeTransaction([
        tx.objectStore('clips').put(snapshot.clip),
        tx.objectStore('projects').put({
            ...project,
            clipIds,
            updatedAt: Date.now(),
        }),
        tx.objectStore('undo').delete(projectId),
    ], tx);
    return snapshot.clip;
}
export async function clearUndo(projectId) {
    const db = await getDb();
    await db.delete('undo', projectId);
}
export async function projectTotalDurationMs(projectId) {
    const clips = await getClipMetasForProject(projectId);
    return clips.reduce((sum, clip) => {
        const end = Math.min(clip.trimEndMs, clip.durationMs);
        const start = Math.max(0, Math.min(clip.trimStartMs, end));
        return sum + (end - start);
    }, 0);
}
