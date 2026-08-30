import { describe, expect, it } from 'vitest'
import { pairingHint, pairingHref } from './pairing-href'

describe('pairingHref', () => {
  it('uses the same /kind and /kind/:code shape for receive and unlock', () => {
    expect(pairingHref('receive', null, 'https://kody.video')).toBe('https://kody.video/receive')
    expect(pairingHref('receive', 'AB3K9Q', 'https://kody.video')).toBe(
      'https://kody.video/receive/AB3K9Q',
    )
    expect(pairingHref('unlocked', null, 'https://kody.video')).toBe('https://kody.video/unlocked')
    expect(pairingHref('unlocked', 'ABC234', 'https://kody.video')).toBe(
      'https://kody.video/unlocked/ABC234',
    )
  })
})

describe('pairingHint', () => {
  it('prints the production host path', () => {
    expect(pairingHint('receive')).toBe('kody.video/receive')
    expect(pairingHint('unlocked')).toBe('kody.video/unlocked')
  })
})
