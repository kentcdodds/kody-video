import { useCallback, useRef, type ImgHTMLAttributes, type RefCallback } from 'react'

type BlobImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  blob: Blob
}

type BlobUrlState = { current: string | null; blob: Blob | null }

function bindBlobImageUrl(element: HTMLImageElement | null, blob: Blob, state: BlobUrlState): void {
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

/** Image element bound to a Blob via ref callback (revokes URL on unmount/blob change). */
export function BlobImage({ blob, ...props }: BlobImageProps) {
  const stateRef = useRef<BlobUrlState>({
    current: null,
    blob: null,
  })

  const setImageRef = useCallback<RefCallback<HTMLImageElement>>(
    (element) => {
      bindBlobImageUrl(element, blob, stateRef.current)
    },
    [blob],
  )

  return <img {...props} ref={setImageRef} />
}
