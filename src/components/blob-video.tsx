import { useRef, type VideoHTMLAttributes } from 'react'
import { bindBlobUrl } from '../lib/blob-url'

type BlobVideoProps = Omit<VideoHTMLAttributes<HTMLVideoElement>, 'src'> & {
  blob: Blob
}

/** Video element bound to a Blob via ref callback (revokes URL on unmount). */
export function BlobVideo({ blob, ...props }: BlobVideoProps) {
  const urlRef = useRef<string | null>(null)

  return (
    <video
      {...props}
      ref={(element) => {
        bindBlobUrl(element, blob, urlRef)
      }}
    />
  )
}
