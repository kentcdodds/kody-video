/** Canonical pairing URLs — same path shape for receive and Plus unlock. */

export type PairingKind = 'receive' | 'unlocked'

export function pairingHref(
  kind: PairingKind,
  code?: string | null,
  origin: string = typeof window !== 'undefined' ? window.location.origin : '',
): string {
  const base = `${origin}/${kind}`
  return code ? `${base}/${code}` : base
}

/** Spoken/printed host path (always the production host, like the About copy). */
export function pairingHint(kind: PairingKind): string {
  return `kody.video/${kind}`
}
