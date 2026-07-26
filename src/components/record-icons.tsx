/** Stroke icons for the record screen chrome (~20–22px inside 44px buttons). */

const iconProps = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
  focusable: false as const,
}

export function IconBack() {
  return (
    <svg {...iconProps}>
      <path d="M15 18l-6-6 6-6" />
    </svg>
  )
}

export function IconFlip() {
  return (
    <svg {...iconProps}>
      <path d="M17 1l4 4-4 4" />
      <path d="M3 11V9a4 4 0 014-4h14" />
      <path d="M7 23l-4-4 4-4" />
      <path d="M21 13v2a4 4 0 01-4 4H3" />
    </svg>
  )
}

export function IconTorch({ on }: { on: boolean }) {
  return (
    <svg {...iconProps}>
      <path d="M9 18h6" />
      <path d="M10 22h4" />
      <path d="M12 2v3" />
      <path d="M8.5 5h7L17 9.5 15 14H9L7 9.5 8.5 5z" />
      {on ? <path d="M12 9v3" /> : null}
    </svg>
  )
}

export function IconEditor() {
  return (
    <svg {...iconProps}>
      <circle cx="6" cy="6" r="2.25" />
      <circle cx="6" cy="18" r="2.25" />
      <path d="M20 4L8.2 15.8" />
      <path d="M14.5 4.5L20 10" />
      <path d="M8.2 8.2L20 20" />
    </svg>
  )
}

export function IconTimer() {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2.5 1.5" />
      <path d="M9 2h6" />
      <path d="M12 2v2" />
    </svg>
  )
}

export function IconPlay() {
  return (
    <svg {...iconProps}>
      <path d="M8 6.2v11.6L18.5 12 8 6.2z" />
    </svg>
  )
}

export function IconDelete() {
  return (
    <svg {...iconProps}>
      <path d="M8 6h13" />
      <path d="M10 6l-.8 12.2A2 2 0 0011.2 20h5.6a2 2 0 001.99-1.8L18 6" />
      <path d="M14 10v6" />
      <path d="M11 10v6" />
      <path d="M6 6l1-2h4l1 2" />
    </svg>
  )
}
