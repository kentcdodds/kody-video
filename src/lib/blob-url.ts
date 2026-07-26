/** Create an object URL and revoke it when the owning element unmounts or the blob changes. */
export function bindBlobUrl(
  element: HTMLMediaElement | null,
  blob: Blob,
  state: { current: string | null; blob: Blob | null },
): void {
  if (!element) {
    if (state.current) {
      URL.revokeObjectURL(state.current)
    }
    state.current = null
    state.blob = null
    return
  }

  if (state.blob !== blob || !state.current) {
    if (state.current) {
      URL.revokeObjectURL(state.current)
    }
    state.current = URL.createObjectURL(blob)
    state.blob = blob
  }

  if (element.src !== state.current) {
    element.src = state.current
  }
}
