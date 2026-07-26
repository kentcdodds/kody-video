import { useCallback, useRef, type ImgHTMLAttributes, type RefCallback } from 'react'

type TimelineThumbImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  blob: Blob
}

/** Bind a Blob to an <img> via object URL (create/revoke on mount/blob change). */
export function TimelineThumbImage({ blob, alt = '', ...props }: TimelineThumbImageProps) {
  const stateRef = useRef<{ current: string | null; blob: Blob | null }>({
    current: null,
    blob: null,
  })

  const setImgRef = useCallback<RefCallback<HTMLImageElement>>(
    (element) => {
      const state = stateRef.current
      if (!element) {
        if (state.current) URL.revokeObjectURL(state.current)
        state.current = null
        state.blob = null
        return
      }

      if (state.blob !== blob || !state.current) {
        if (state.current) URL.revokeObjectURL(state.current)
        state.current = URL.createObjectURL(blob)
        state.blob = blob
      }

      if (element.src !== state.current) {
        element.src = state.current
      }
    },
    [blob],
  )

  return <img {...props} alt={alt} ref={setImgRef} draggable={false} />
}
