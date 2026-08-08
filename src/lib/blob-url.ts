/**
 * Keep a media/img element's `src` bound to a Blob via object URL.
 *
 * Returns a small binder whose `attach` is designed for the `ref()` mixin
 * (bind on insert, revoke on removal via the abort signal) and whose `sync`
 * re-binds when the blob identity changes between renders.
 */
export function createBlobUrlBinder<E extends HTMLElement & { src: string }>(
  getBlob: () => Blob,
) {
  let element: E | null = null
  let url: string | null = null
  let boundBlob: Blob | null = null
  let attachToken = 0

  function sync(): void {
    if (!element) return
    const blob = getBlob()
    if (boundBlob !== blob || !url) {
      if (url) URL.revokeObjectURL(url)
      url = URL.createObjectURL(blob)
      boundBlob = blob
    }
    if (element.src !== url) {
      element.src = url
    }
  }

  function attach(node: E, signal: AbortSignal): void {
    element = node
    const token = ++attachToken
    sync()
    signal.addEventListener('abort', () => {
      // A remount can attach the replacement — possibly the SAME node with a
      // new signal — before the old attachment's teardown runs; by then the
      // binder (and its URL) belong to the newer attachment, and revoking
      // here would kill the src just handed to it. The token, not node
      // identity, decides ownership.
      if (token !== attachToken) return
      if (url) URL.revokeObjectURL(url)
      element = null
      url = null
      boundBlob = null
    })
  }

  return { attach, sync }
}
