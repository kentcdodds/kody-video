import { useRef, type VideoHTMLAttributes } from 'react'
import { bindBlobUrl } from '../lib/blob-url'

type BlobVideoProps = Omit<VideoHTMLAttributes<HTMLVideoElement>, 'src'> & {
  blob: Blob
}

/** Video element bound to a Blob via ref callback (revokes URL on unmount/blob change). */
export function BlobVideo({ blob, ...props }: BlobVideoProps) {
  const stateRef = useRef<{ current: string | null; blob: Blob | null }>({
    current: null,
    blob: null,
  })

  return (
    <video
      {...props}
      ref={(element) => {
        bindBlobUrl(element, blob, stateRef.current)
      }}
    />
  )
}
