import type { Handle } from 'remix/ui'
import { qrSvgDataUrl } from '../lib/sync-qr-svg'

interface SyncQrProps {
  href: string
  label?: string
}

/** QR for a pairing URL — scanned on the other device. */
export function SyncQr(handle: Handle<SyncQrProps>) {
  return () => {
    const label = handle.props.label ?? 'QR code to receive this project'
    return (
      <img
        className="sync-qr"
        src={qrSvgDataUrl(handle.props.href)}
        alt={label}
        width={220}
        height={220}
      />
    )
  }
}
