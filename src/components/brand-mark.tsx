interface BrandMarkProps {
  size?: number
  className?: string
}

export function BrandMark({ size = 56, className }: BrandMarkProps) {
  return (
    <img
      className={className}
      width={size}
      height={size}
      src="/kody-profile.png"
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}
