import type { Handle, MixValue } from 'remix/ui'
import { ref } from 'remix/ui'
import { createBlobUrlBinder } from '../lib/blob-url'

interface BlobImageProps {
  blob: Blob
  className?: string
  alt?: string
  'aria-hidden'?: boolean | 'true' | 'false'
  draggable?: boolean
  mix?: MixValue
}

/** Image element bound to a Blob via object URL (revoked on unmount/blob change). */
export function BlobImage(handle: Handle<BlobImageProps>) {
  const binder = createBlobUrlBinder<HTMLImageElement>(() => handle.props.blob)

  return () => {
    const { blob: _blob, mix, ...props } = handle.props
    binder.sync()
    return (
      <img
        {...props}
        mix={[mix, ref((node, signal) => binder.attach(node as HTMLImageElement, signal))]}
      />
    )
  }
}
