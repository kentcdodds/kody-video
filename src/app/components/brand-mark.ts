import { fromHtml } from '../dom.ts'

const sources = {
  mark: { webp: '/kody-mark.webp', fallback: '/kody-profile.png' },
  camera: { webp: '/art/kody-holding-camera.webp', fallback: '/kody-profile.png' },
  timeline: { webp: '/art/kody-timeline-peek.webp', fallback: '/kody-profile.png' },
  share: { webp: '/art/kody-thumbs-up-share.webp', fallback: '/kody-profile.png' },
  icon: { webp: '/art/kody-app-icon.webp', fallback: '/pwa-192.png' },
}

export type BrandVariant = keyof typeof sources

export interface BrandMarkOptions {
  size?: number
  className?: string
  variant?: BrandVariant
}

/** Kody artwork <picture> (webp with png fallback). */
export function brandMark({ size = 56, className, variant = 'mark' }: BrandMarkOptions = {}): HTMLElement {
  const src = sources[variant]
  return fromHtml(
    `<picture${className ? ` class="${className}-picture"` : ''}>` +
      `<source srcset="${src.webp}" type="image/webp" />` +
      `<img${className ? ` class="${className}"` : ''} width="${size}" height="${size}" ` +
      `src="${src.fallback}" alt="" aria-hidden="true" draggable="false" decoding="async" />` +
      `</picture>`,
  )
}
