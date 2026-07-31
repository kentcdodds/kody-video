/**
 * OPFS-backed export output. A half-hour export is ~1GB of encoded data —
 * accumulating that in an in-memory ArrayBuffer (then copying it for
 * metadata injection and Blob creation) OOM-killed the tab right at 100%.
 * Streaming the mux to an Origin Private File System file keeps memory flat
 * regardless of duration; the resulting File is disk-backed, so sharing and
 * saving never load it into RAM either.
 */

export interface OpfsExportFile {
  writable: FileSystemWritableFileStream
  /** The finished, disk-backed file (call after the writer is closed). */
  getFile(): Promise<File>
  /** Abort + delete on export failure. */
  discard(): Promise<void>
}

const EXPORT_DIR = 'exports'

/**
 * Returns null when OPFS isn't available (the caller falls back to an
 * in-memory buffer). Previous export files are cleaned up here — by the
 * time a new export starts, the UI has discarded any old result.
 */
/** Write a stream into a named OPFS file (overwriting), returning the
 * disk-backed File — or null when OPFS is unavailable. */
export async function streamToOpfsFile(
  name: string,
  stream: ReadableStream<Uint8Array>,
): Promise<File | null> {
  try {
    if (!navigator.storage?.getDirectory) return null
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle(EXPORT_DIR, { create: true })
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
    if (!navigator.storage?.getDirectory) return null
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle(EXPORT_DIR, { create: true })
    const handle = await dir.getFileHandle(name)
    return await handle.getFile()
  } catch {
    return null
  }
}

export async function createOpfsExportFile(extension: string): Promise<OpfsExportFile | null> {
  try {
    if (!navigator.storage?.getDirectory) return null
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle(EXPORT_DIR, { create: true })

    // Best-effort cleanup of earlier temp exports. Persisted artifacts
    // (the recoverable last export, clip zips) are kept — they must survive
    // a new export attempt that might fail.
    try {
      const names: string[] = []
      for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
        if (name.startsWith('export-')) names.push(name)
      }
      await Promise.all(names.map((name) => dir.removeEntry(name).catch(() => undefined)))
    } catch {
      // Cleanup is a nicety.
    }

    const name = `export-${Date.now()}.${extension}`
    const handle = await dir.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    return {
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
