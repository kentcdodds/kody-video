import type { Handle, MixInput } from 'remix/ui'
import { ref } from 'remix/ui'
import { createBlobUrlBinder } from '../lib/blob-url'

interface BlobVideoProps {
  blob: Blob
  className?: string
  playsInline?: boolean
  preload?: 'none' | 'metadata' | 'auto'
  muted?: boolean
  autoPlay?: boolean
  /** Outer ref to the underlying element (insert + abort on removal). */
  videoRef?: (element: HTMLVideoElement, signal: AbortSignal) => void
  mix?: MixInput<HTMLVideoElement>
}

/** Video element bound to a Blob via object URL (revoked on unmount/blob change). */
export function BlobVideo(handle: Handle<BlobVideoProps>) {
  const binder = createBlobUrlBinder<HTMLVideoElement>(() => handle.props.blob)

  return () => {
    const { blob: _blob, videoRef, mix, ...props } = handle.props
    binder.sync()
    return (
      <video
        {...props}
        mix={[
          mix,
          ref((node, signal) => {
            binder.attach(node as HTMLVideoElement, signal)
            videoRef?.(node as HTMLVideoElement, signal)
          }),
        ]}
      />
    )
  }
}
