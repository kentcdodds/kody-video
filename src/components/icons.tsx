/** Cohesive stroke icon set (24×24 viewBox, ~2–3px padding, optical balance). */

import type { Handle } from 'remix/ui'

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
    focusable: false,
  }
}

export function IconBack(handle: Handle<IconProps>) {
  return () => (
    <svg {...baseProps(handle.props.size ?? 22)}>
      <path d="M15 18l-6-6 6-6" />
    </svg>
  )
}

export function IconFlip(handle: Handle<IconProps>) {
  return () => (
    <svg {...baseProps(handle.props.size ?? 22)}>
      <path d="M16 4l3 3-3 3" />
      <path d="M4 11V9a4 4 0 014-4h11" />
      <path d="M8 20l-3-3 3-3" />
      <path d="M20 13v2a4 4 0 01-4 4H5" />
    </svg>
  )
}

export function IconTorch(handle: Handle<IconProps & { on?: boolean }>) {
  return () => (
    <svg {...baseProps(handle.props.size ?? 22)}>
      <path
        d="M13 3L7 13h5l-1 8 6-10h-5l1-8z"
        fill={handle.props.on ? 'currentColor' : 'none'}
      />
    </svg>
  )
}

export function IconTimer(handle: Handle<IconProps>) {
  return () => (
    <svg {...baseProps(handle.props.size ?? 22)}>
      <circle cx="12" cy="13" r="7" />
      <path d="M12 10v3.5l2 1.2" />
      <path d="M9 3.5h6" />
      <path d="M12 3.5V5" />
    </svg>
  )
}

/** Map-pin outline for location tagging. */
export function IconLocation(handle: Handle<IconProps>) {
  return () => (
    <svg {...baseProps(handle.props.size ?? 22)}>
      <path d="M12 20.5s6.5-4.4 6.5-10a6.5 6.5 0 10-13 0c0 5.6 6.5 10 6.5 10z" />
      <circle cx="12" cy="10.5" r="2.25" />
    </svg>
  )
}

export function IconPlay(handle: Handle<IconProps>) {
  return () => (
    <svg {...baseProps(handle.props.size ?? 22)}>
      <path d="M8 6.5v11L18 12 8 6.5z" />
    </svg>
  )
}

export function IconPause(handle: Handle<IconProps>) {
  return () => (
    <svg {...baseProps(handle.props.size ?? 22)}>
      <path d="M9 6.5v11" />
      <path d="M15 6.5v11" />
    </svg>
  )
}

/** Filmstrip: mirrors the clip timeline the editor button opens. */
export function IconEditor(handle: Handle<IconProps>) {
  return () => (
    <svg {...baseProps(handle.props.size ?? 22)}>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M7.5 4.5v15" />
      <path d="M16.5 4.5v15" />
      <path d="M3 9.5h4.5" />
      <path d="M3 14.5h4.5" />
      <path d="M16.5 9.5H21" />
      <path d="M16.5 14.5H21" />
      <path d="M7.5 12h9" />
    </svg>
  )
}

/** Backspace-style control for deleting the last recorded clip. */
export function IconDeleteLast(handle: Handle<IconProps>) {
  return () => (
    <svg {...baseProps(handle.props.size ?? 22)}>
      <path d="M18.5 6H9.2L4.5 12l4.7 6H18.5a2 2 0 002-2V8a2 2 0 00-2-2z" />
      <path d="M11.5 10l5 5" />
      <path d="M16.5 10l-5 5" />
    </svg>
  )
}

/** Straight-sided bin with a rounded base; sturdier than a tapered can at small sizes. */
export function IconTrash(handle: Handle<IconProps>) {
  return () => (
    <svg {...baseProps(handle.props.size ?? 22)}>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5.5A1.5 1.5 0 0111 4h2a1.5 1.5 0 011.5 1.5V7" />
      <path d="M18 7v11a2.5 2.5 0 01-2.5 2.5h-7A2.5 2.5 0 016 18V7" />
      <path d="M10 11v5.5" />
      <path d="M14 11v5.5" />
    </svg>
  )
}

export function IconDuplicate(handle: Handle<IconProps>) {
  return () => (
    <svg {...baseProps(handle.props.size ?? 22)}>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5V6.5A2 2 0 0013.5 4.5h-7a2 2 0 00-2 2v7a2 2 0 002 2h2" />
    </svg>
  )
}

/** Bracket / I-beam handles that read as “trim”. */
export function IconTrim(handle: Handle<IconProps>) {
  return () => (
    <svg {...baseProps(handle.props.size ?? 22)}>
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

export function IconChevronLeft(handle: Handle<IconProps>) {
  return () => (
    <svg {...baseProps(handle.props.size ?? 22)}>
      <path d="M14.5 6l-6 6 6 6" />
    </svg>
  )
}

export function IconChevronRight(handle: Handle<IconProps>) {
  return () => (
    <svg {...baseProps(handle.props.size ?? 22)}>
      <path d="M9.5 6l6 6-6 6" />
    </svg>
  )
}

export function IconPlus(handle: Handle<IconProps>) {
  return () => (
    <svg {...baseProps(handle.props.size ?? 22)}>
      <path d="M12 6v12" />
      <path d="M6 12h12" />
    </svg>
  )
}

export function IconMore(handle: Handle<IconProps>) {
  return () => (
    <svg {...baseProps(handle.props.size ?? 22)}>
      <circle cx="6" cy="12" r="1.75" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.75" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.75" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconUndo(handle: Handle<IconProps>) {
  return () => (
    <svg {...baseProps(handle.props.size ?? 22)}>
      <path d="M7 5L4 8l3 3" />
      <path d="M4 8h7a5 5 0 110 10H9" />
    </svg>
  )
}

/** The iOS share glyph: box with an arrow rising out of it. */
export function IconShareIos(handle: Handle<IconProps>) {
  return () => (
    <svg {...baseProps(handle.props.size ?? 22)}>
      <path d="M8 8H6a1 1 0 00-1 1v11a1 1 0 001 1h12a1 1 0 001-1V9a1 1 0 00-1-1h-2" />
      <path d="M12 14V3" />
      <path d="M8.5 6.5L12 3l3.5 3.5" />
    </svg>
  )
}

export function IconClose(handle: Handle<IconProps>) {
  return () => (
    <svg {...baseProps(handle.props.size ?? 22)}>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </svg>
  )
}

export function IconLens(handle: Handle<IconProps>) {
  return () => (
    <svg {...baseProps(handle.props.size ?? 22)}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  )
}

export function IconLock(handle: Handle<IconProps>) {
  return () => (
    <svg {...baseProps(handle.props.size ?? 22)}>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 018 0v3" />
    </svg>
  )
}

/** Monitor with a record dot: screen recording. */
export function IconScreen(handle: Handle<IconProps & { on?: boolean }>) {
  return () => (
    <svg {...baseProps(handle.props.size ?? 22)}>
      <rect x="3" y="4.5" width="18" height="12.5" rx="2" />
      <path d="M9 20.5h6" />
      <circle cx="12" cy="10.75" r="2.4" fill={handle.props.on ? 'currentColor' : 'none'} />
    </svg>
  )
}
