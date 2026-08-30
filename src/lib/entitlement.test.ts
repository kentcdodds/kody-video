import { describe, expect, it } from 'vitest'
import {
  extractRestoreToken,
  extractSessionId,
  looksLikeStripeReceipt,
} from './entitlement'

describe('extractRestoreToken', () => {
  it('pulls a checkout session id out of a success URL', () => {
    expect(
      extractSessionId('https://kody.video/unlocked?session_id=cs_live_b1tCTabc123'),
    ).toBe('cs_live_b1tCTabc123')
    expect(extractRestoreToken('cs_test_e2e')).toEqual({ kind: 'session', value: 'cs_test_e2e' })
  })

  it('accepts a 6-character restore code with or without a hyphen', () => {
    expect(extractRestoreToken('ABC-234')).toEqual({ kind: 'code', value: 'ABC234' })
    expect(extractRestoreToken('abc234')).toEqual({ kind: 'code', value: 'ABC234' })
  })

  it('pulls a restore code out of a copied unlock URL', () => {
    expect(extractRestoreToken('https://kody.video/unlocked?code=ABC234')).toEqual({
      kind: 'code',
      value: 'ABC234',
    })
    expect(extractRestoreToken('https://kody.video/unlocked?code=ABC-234')).toEqual({
      kind: 'code',
      value: 'ABC234',
    })
    expect(extractRestoreToken('kody.video/unlocked?code=ABC234')).toEqual({
      kind: 'code',
      value: 'ABC234',
    })
    expect(extractRestoreToken('https://kody.video/unlocked/ABC234')).toEqual({
      kind: 'code',
      value: 'ABC234',
    })
    expect(extractRestoreToken('https://kody.video/unlocked/ABC-234')).toEqual({
      kind: 'code',
      value: 'ABC234',
    })
    expect(extractRestoreToken('kody.video/unlocked/ABC234')).toEqual({
      kind: 'code',
      value: 'ABC234',
    })
  })

  it('does not treat a Stripe receipt URL as a session id', () => {
    const receipt =
      'https://pay.stripe.com/receipts/invoices/CAcQARoXChVhY2N0XzFQT2hYV0xBUXBBbnNZc3o'
    expect(extractSessionId(receipt)).toBeNull()
    expect(extractRestoreToken(receipt)).toBeNull()
    expect(looksLikeStripeReceipt(receipt)).toBe(true)
  })
})
