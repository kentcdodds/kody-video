/** Thrown when the user stops an in-flight export (mark/location change or Stop). */
export class ExportCancelledError extends Error {
  constructor() {
    super('Export cancelled')
    this.name = 'ExportCancelledError'
  }
}

export function isExportCancelled(error: unknown): boolean {
  if (error instanceof ExportCancelledError) return true
  if (error instanceof DOMException && error.name === 'AbortError') return true
  return error instanceof Error && error.name === 'ExportCancelledError'
}

export function throwIfExportAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ExportCancelledError()
}
