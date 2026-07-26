/** Create an object URL and revoke it when the owning element unmounts. */
export function bindBlobUrl(
  element: HTMLMediaElement | null,
  blob: Blob,
  currentUrl: { current: string | null },
): void {
  if (!element) {
    if (currentUrl.current) {
      URL.revokeObjectURL(currentUrl.current)
      currentUrl.current = null
    }
    return
  }

  if (!currentUrl.current) {
    currentUrl.current = URL.createObjectURL(blob)
  }
  if (element.src !== currentUrl.current) {
    element.src = currentUrl.current
  }
}
