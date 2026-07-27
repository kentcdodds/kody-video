/** Cohesive stroke icon set (24×24 viewBox, ~2–3px padding, optical balance). */

interface IconProps {
  size?: number
}

function baseProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
    focusable: false as const,
  }
}

export function IconBack({ size = 22 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M15 18l-6-6 6-6" />
    </svg>
  )
}

export function IconFlip({ size = 22 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M16 4l3 3-3 3" />
      <path d="M4 11V9a4 4 0 014-4h11" />
      <path d="M8 20l-3-3 3-3" />
      <path d="M20 13v2a4 4 0 01-4 4H5" />
    </svg>
  )
}

export function IconTorch({ size = 22, on = false }: IconProps & { on?: boolean }) {
  return (
    <svg {...baseProps(size)}>
      <path
        d="M13 3L7 13h5l-1 8 6-10h-5l1-8z"
        fill={on ? 'currentColor' : 'none'}
      />
    </svg>
  )
}

export function IconTimer({ size = 22 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <circle cx="12" cy="13" r="7" />
      <path d="M12 10v3.5l2 1.2" />
      <path d="M9 3.5h6" />
      <path d="M12 3.5V5" />
    </svg>
  )
}

export function IconPlay({ size = 22 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M8 6.5v11L18 12 8 6.5z" />
    </svg>
  )
}

export function IconPause({ size = 22 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M9 6.5v11" />
      <path d="M15 6.5v11" />
    </svg>
  )
}

export function IconEditor({ size = 22 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <circle cx="6.5" cy="6.5" r="2.25" />
      <circle cx="6.5" cy="17.5" r="2.25" />
      <path d="M19.5 4.5L8.7 15.3" />
      <path d="M14.2 5L19.5 10.3" />
      <path d="M8.7 8.7L19.5 19.5" />
    </svg>
  )
}

/** Backspace-style control for deleting the last recorded clip. */
export function IconDeleteLast({ size = 22 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M18.5 6H9.2L4.5 12l4.7 6H18.5a2 2 0 002-2V8a2 2 0 00-2-2z" />
      <path d="M11.5 10l5 5" />
      <path d="M16.5 10l-5 5" />
    </svg>
  )
}

export function IconTrash({ size = 22 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M5 7h14" />
      <path d="M9 7V5.5A1.5 1.5 0 0110.5 4h3A1.5 1.5 0 0115 5.5V7" />
      <path d="M8 7l.7 11.2A1.5 1.5 0 0010.2 19.5h3.6a1.5 1.5 0 001.5-1.3L16 7" />
      <path d="M10.5 11v5" />
      <path d="M13.5 11v5" />
    </svg>
  )
}

export function IconDuplicate({ size = 22 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5V6.5A2 2 0 0013.5 4.5h-7a2 2 0 00-2 2v7a2 2 0 002 2h2" />
    </svg>
  )
}

/** Bracket / I-beam handles that read as “trim”. */
export function IconTrim({ size = 22 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M5 6v12" />
      <path d="M3.5 6h3" />
      <path d="M3.5 18h3" />
      <path d="M19 6v12" />
      <path d="M17.5 6h3" />
      <path d="M17.5 18h3" />
      <path d="M9 12h6" />
    </svg>
  )
}

export function IconChevronLeft({ size = 22 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M14.5 6l-6 6 6 6" />
    </svg>
  )
}

export function IconChevronRight({ size = 22 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M9.5 6l6 6-6 6" />
    </svg>
  )
}

export function IconPlus({ size = 22 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M12 6v12" />
      <path d="M6 12h12" />
    </svg>
  )
}

export function IconMore({ size = 22 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <circle cx="6" cy="12" r="1.75" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.75" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.75" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconUndo({ size = 22 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M7 5L4 8l3 3" />
      <path d="M4 8h7a5 5 0 110 10H9" />
    </svg>
  )
}
