/**
 * Stripe's Payment Link redirects here after checkout with
 * ?session_id={CHECKOUT_SESSION_ID}; the page verifies it server-side and
 * persists the entitlement before rendering the result.
 */

import { define, h, KvElement } from '../dom.ts'
import { verifyPurchaseSession, type VerifyResult } from '../lib/entitlement.ts'
import { brandMark } from '../components/brand-mark.ts'

async function verifyFromLocation(): Promise<VerifyResult> {
  const sessionId = new URL(window.location.href).searchParams.get('session_id')
  if (!sessionId) {
    return { unlocked: false, error: 'Missing checkout session. Use the link from your receipt.' }
  }
  return verifyPurchaseSession(sessionId)
}

export class KvUnlockedPage extends KvElement<void> {
  result: VerifyResult | null = null

  override mounted(): void {
    void verifyFromLocation().then((verified) => {
      if (this.signal.aborted) return
      this.result = verified
      this.update()
    })
  }

  override render(): void {
    const result = this.result
    const body =
      result === null
        ? [h('p', { className: 'eyebrow' }, 'Checking your purchase…'), h('h1', null, 'One moment')]
        : result.unlocked
          ? [
              h('p', { className: 'eyebrow' }, 'Purchase verified'),
              h('h1', null, 'Kody Video Plus unlocked! 🎉'),
              h(
                'p',
                { className: 'muted' },
                'Thank you for supporting Kody Video. Every export from this device is now ' +
                  'watermark-free and all six project slots are open. Keep your Stripe receipt ' +
                  'email — its link restores the purchase on another device.',
              ),
            ]
          : [
              h('p', { className: 'eyebrow' }, 'Verification failed'),
              h('h1', null, 'Hmm, that didn’t check out'),
              h(
                'p',
                { className: 'muted' },
                `${result.error ?? 'Could not verify this purchase.'} If you paid and keep seeing ` +
                  'this, retry from the link in your Stripe receipt email.',
              ),
            ]

    this.replaceChildren(
      h(
        'div',
        { className: 'screen unlocked-screen' },
        h(
          'div',
          { className: 'unlocked-card' },
          brandMark({ size: 110, className: 'export-celebrate-art', variant: 'share' }),
          body,
          result === null
            ? null
            : h(
                'a',
                { className: 'btn btn-primary', href: '/' },
                result.unlocked ? 'Start creating' : 'Back to Kody Video',
              ),
        ),
      ),
    )
  }
}
define('kv-unlocked-page', KvUnlockedPage)
