/** Thrown when the user stops an in-flight export (mark/location change or Stop). */
export class ExportCancelledError extends Error {
  constructor() {
    super('Export cancelled')
    this.name = 'ExportCancelledError'
  }
}

export function isExportCancelled(error: unknown): boolean {
  return (
    error instanceof ExportCancelledError ||
    (error instanceof Error && error.name === 'ExportCancelledError')
  )
}

export function throwIfExportAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ExportCancelledError()
}

/**
 * Decode-pump catch policy: a cancel before the first frame must not look
 * like "unsupported codec" (that would start the realtime fallback).
 */
export function decodedPumpFailure(
  error: unknown,
  framesEmitted: number,
  signal?: AbortSignal,
): 'unsupported' {
  if (isExportCancelled(error) || signal?.aborted) {
    throw error instanceof ExportCancelledError ? error : new ExportCancelledError()
  }
  if (framesEmitted > 0) {
    throw error instanceof Error ? error : new Error('Decoded video pump failed')
  }
  return 'unsupported'
}
