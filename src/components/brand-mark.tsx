import type { Handle } from 'remix/ui'

interface BrandMarkProps {
  size?: number
  className?: string
  /** Visual variant for different surfaces. */
  variant?: 'mark' | 'camera' | 'timeline' | 'share' | 'icon'
  /**
   * Home LCP art. Renders a same-size spacer; the visible image lives in
   * index.html `#boot-hero` so first paint is not gated on the SPA bundle.
   */
  priority?: boolean
}

const sources: Record<NonNullable<BrandMarkProps['variant']>, { webp: string; fallback: string }> = {
  mark: { webp: '/kody-mark.webp', fallback: '/kody-profile.png' },
  camera: {
    webp: '/art/kody-holding-camera-192.webp',
    fallback: '/kody-profile.png',
  },
  timeline: {
    webp: '/art/kody-timeline-peek-192.webp',
    fallback: '/kody-profile.png',
  },
  share: {
    webp: '/art/kody-thumbs-up-share-192.webp',
    fallback: '/kody-profile.png',
  },
  icon: {
    webp: '/art/kody-app-icon-192.webp',
    fallback: '/pwa-192.png',
  },
}

export function BrandMark(handle: Handle<BrandMarkProps>) {
  return () => {
    const { size = 56, className, variant = 'mark', priority = false } = handle.props
    const src = sources[variant]

    if (priority) {
      return (
        <div
          className={className}
          style={{ width: size, height: size }}
          aria-hidden="true"
        />
      )
    }

    return (
      <picture className={className ? `${className}-picture` : undefined}>
        <source srcSet={src.webp} type="image/webp" />
        <img
          className={className}
          width={size}
          height={size}
          src={src.fallback}
          alt=""
          aria-hidden="true"
          draggable={false}
          decoding="async"
        />
      </picture>
    )
  }
}
