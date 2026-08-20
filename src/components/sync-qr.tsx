import type { Handle } from 'remix/ui'
import { ref } from 'remix/ui'
import { renderSVG } from 'uqr'

interface SyncQrProps {
  href: string
  label?: string
}

/** QR for a pairing URL — scanned on the other device. */
export function SyncQr(handle: Handle<SyncQrProps>) {
  return () => {
    const svg = renderSVG(handle.props.href, {
      ecc: 'M',
      pixelSize: 8,
      whiteColor: '#f3f5f4',
      blackColor: '#1a2824',
    })
    return (
      <div
        className="sync-qr"
        role="img"
        aria-label={handle.props.label ?? 'QR code to receive this project'}
        mix={ref((node) => {
          ;(node as HTMLElement).innerHTML = svg
        })}
      />
    )
  }
}
