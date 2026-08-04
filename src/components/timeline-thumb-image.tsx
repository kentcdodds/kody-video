import type { Handle, MixValue } from 'remix/ui'
import { ref } from 'remix/ui'
import { createBlobUrlBinder } from '../lib/blob-url'

interface TimelineThumbImageProps {
  blob: Blob
  className?: string
  alt?: string
  mix?: MixValue
}

/** Bind a Blob to an <img> via object URL (create/revoke on mount/blob change). */
export function TimelineThumbImage(handle: Handle<TimelineThumbImageProps>) {
  const binder = createBlobUrlBinder<HTMLImageElement>(() => handle.props.blob)

  return () => {
    const { blob: _blob, alt = '', mix, ...props } = handle.props
    binder.sync()
    return (
      <img
        {...props}
        alt={alt}
        draggable={false}
        mix={[mix, ref((node, signal) => binder.attach(node as HTMLImageElement, signal))]}
      />
    )
  }
}
