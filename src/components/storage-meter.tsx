import type { Handle } from 'remix/ui'
import { on } from 'remix/ui'
import * as Popover from 'remix/ui/popover'
import {
  formatBytes,
  formatStoragePercent,
  storageSeverity,
  type StorageSpace,
} from '../lib/storage-space'

interface StorageMeterProps {
  storage: StorageSpace
}

/**
 * Subtle device-storage gauge for the home footer: a short progress bar
 * (replacing the old "X of Y used" text) that opens a detail popover on tap.
 */
export function StorageMeter(handle: Handle<StorageMeterProps>) {
  let open = false
  const setOpen = (next: boolean) => {
    open = next
    void handle.update()
  }

  return () => {
    const { storage } = handle.props
    const severity = storageSeverity(storage.ratio)
    const percent = formatStoragePercent(storage.ratio)
    const detail = `${formatBytes(storage.usedBytes)} of ${formatBytes(storage.quotaBytes)} used`
    // Never fully empty: a hairline of fill keeps the bar readable as a gauge.
    const fillPercent = Math.max(3, Math.round(storage.ratio * 100))

    return (
      <Popover.Context>
        <button
          type="button"
          className={`storage-meter${severity === 'ok' ? '' : ` is-${severity}`}`}
          aria-label={`Device storage: ${detail} (${percent} full)`}
          aria-expanded={open}
          mix={[
            Popover.anchor({ placement: 'top', offset: 8 }),
            on('click', () => setOpen(!open)),
            // Focus stays on this button when the popover opens, so the
            // surface's own Escape handler never hears the key.
            on('keydown', (event) => {
              if (event.key === 'Escape' && open) setOpen(false)
            }),
          ]}
        >
          <span className="storage-meter-track" aria-hidden="true">
            <span className="storage-meter-fill" style={{ width: `${fillPercent}%` }} />
          </span>
        </button>
        <div
          className="storage-popover"
          mix={Popover.surface({
            open,
            onHide: () => setOpen(false),
            // The anchor's own click handler toggles; without this an
            // outside-click close + toggle would cancel out.
            closeOnAnchorClick: false,
          })}
        >
          <strong>Device storage {percent} full</strong>
          <span>{detail}</span>
        </div>
      </Popover.Context>
    )
  }
}
