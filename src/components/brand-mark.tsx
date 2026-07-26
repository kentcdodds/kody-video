interface BrandMarkProps {
  size?: number
  className?: string
  /** Visual variant for different surfaces. */
  variant?: 'mark' | 'camera' | 'timeline' | 'share' | 'icon'
}

const sources: Record<NonNullable<BrandMarkProps['variant']>, { webp: string; fallback: string }> = {
  mark: { webp: '/kody-mark.webp', fallback: '/kody-profile.png' },
  camera: {
    webp: '/art/kody-holding-camera.webp',
    fallback: '/kody-profile.png',
  },
  timeline: {
    webp: '/art/kody-timeline-peek.webp',
    fallback: '/kody-profile.png',
  },
  share: {
    webp: '/art/kody-thumbs-up-share.webp',
    fallback: '/kody-profile.png',
  },
  icon: {
    webp: '/art/kody-app-icon.webp',
    fallback: '/pwa-192.png',
  },
}

export function BrandMark({ size = 56, className, variant = 'mark' }: BrandMarkProps) {
  const src = sources[variant]

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
