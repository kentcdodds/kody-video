import { useCallback, useRef, type RefCallback, type VideoHTMLAttributes } from 'react'
import { bindBlobUrl } from '../lib/blob-url'

type BlobVideoProps = Omit<VideoHTMLAttributes<HTMLVideoElement>, 'src'> & {
  blob: Blob
  /** Outer ref to the underlying element (mount/unmount, like a plain ref). */
  videoRef?: RefCallback<HTMLVideoElement>
}

/** Video element bound to a Blob via ref callback (revokes URL on unmount/blob change). */
export function BlobVideo({ blob, videoRef, ...props }: BlobVideoProps) {
  const stateRef = useRef<{ current: string | null; blob: Blob | null }>({
    current: null,
    blob: null,
  })

  const setVideoRef = useCallback<RefCallback<HTMLVideoElement>>(
    (element) => {
      bindBlobUrl(element, blob, stateRef.current)
      videoRef?.(element)
    },
    [blob, videoRef],
  )

  return <video {...props} ref={setVideoRef} />
}
