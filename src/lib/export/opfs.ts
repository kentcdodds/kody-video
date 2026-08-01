/**
 * OPFS-backed export output. A half-hour export is ~1GB of encoded data —
 * accumulating that in an in-memory ArrayBuffer (then copying it for
 * metadata injection and Blob creation) OOM-killed the tab right at 100%.
 * Streaming the mux to an Origin Private File System file keeps memory flat
 * regardless of duration; the resulting File is disk-backed, so sharing and
 * saving never load it into RAM either.
 */

export interface OpfsExportFile {
  /** The file's name inside the exports directory. */
  name: string
  writable: FileSystemWritableFileStream
  /** The finished, disk-backed file (call after the writer is closed). */
  getFile(): Promise<File>
  /** Abort + delete on export failure. */
  discard(): Promise<void>
}

const EXPORT_DIR = 'exports'

async function exportsDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (!navigator.storage?.getDirectory) return null
    const root = await navigator.storage.getDirectory()
    return await root.getDirectoryHandle(EXPORT_DIR, { create: true })
  } catch {
    return null
  }
}

export interface OpfsExportEntry {
  name: string
  sizeBytes: number
}

/** Every file in the exports directory with its size (empty when OPFS is
 * unavailable). */
export async function listExportEntries(): Promise<OpfsExportEntry[]> {
  const dir = await exportsDir()
  if (!dir) return []
  const entries: OpfsExportEntry[] = []
  try {
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
      const sizeBytes = await dir
        .getFileHandle(name)
        .then((handle) => handle.getFile())
        .then((file) => file.size)
        .catch(() => 0)
      entries.push({ name, sizeBytes })
    }
  } catch {
    // Enumeration is best-effort.
  }
  return entries
}

/** Best-effort delete of one exports-directory file. */
export async function removeExportEntry(name: string): Promise<void> {
  const dir = await exportsDir()
  if (!dir) return
  await dir.removeEntry(name).catch(() => undefined)
}

/** Write a stream into a named OPFS file (overwriting), returning the
 * disk-backed File — or null when OPFS is unavailable. */
export async function streamToOpfsFile(
  name: string,
  stream: ReadableStream<Uint8Array>,
): Promise<File | null> {
  try {
    const dir = await exportsDir()
    if (!dir) return null
    const handle = await dir.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    await stream.pipeTo(writable)
    return handle.getFile()
  } catch {
    return null
  }
}

/** Read a previously persisted OPFS file, or null when it's gone. */
export async function readOpfsFile(name: string): Promise<File | null> {
  try {
    const dir = await exportsDir()
    if (!dir) return null
    const handle = await dir.getFileHandle(name)
    return await handle.getFile()
  } catch {
    return null
  }
}

/** Returns null when OPFS isn't available (the caller falls back to an
 * in-memory buffer). Stale-file cleanup is the export-cache module's job —
 * it knows which names are still referenced. */
export async function createOpfsExportFile(extension: string): Promise<OpfsExportFile | null> {
  try {
    const dir = await exportsDir()
    if (!dir) return null
    const name = `export-${Date.now()}.${extension}`
    const handle = await dir.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    return {
      name,
      writable,
      getFile: async () => {
        // Mediabunny closes the stream on finalize; close defensively for
        // any path that didn't.
        try {
          await writable.close()
        } catch {
          // Already closed.
        }
        return handle.getFile()
      },
      discard: async () => {
        try {
          await writable.abort()
        } catch {
          // Already closed/aborted.
        }
        try {
          await dir.removeEntry(name)
        } catch {
          // Already gone.
        }
      },
    }
  } catch {
    return null
  }
}
