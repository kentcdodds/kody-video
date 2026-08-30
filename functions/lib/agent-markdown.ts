/**
 * Markdown-for-agents responses for the public pages. The kody.video zone
 * is on Cloudflare's Free plan, so the hosted Markdown for Agents converter
 * cannot be enabled (`content_converter` is not editable). This module is
 * the same Accept: text/markdown negotiation that converter would do.
 */

export const CONTENT_SIGNAL = 'search=yes, ai-input=yes, ai-train=yes'

export type AgentPageId = 'home' | 'about' | 'privacy' | 'terms' | 'receive' | 'auth'

type AgentPage = {
  title: string
  description: string
  canonical: string
  body: string
}

const PAGES: Record<AgentPageId, AgentPage> = {
  home: {
    title: 'Kody Video',
    description:
      'Hold anywhere to record clips. Privacy-first camera for the web. Record shot by shot, trim on a filmstrip, export one video.',
    canonical: 'https://kody.video/',
    body: `# Kody Video

Privacy-first clips camera for the web. Hold anywhere on the preview to record, arrange clips on a filmstrip timeline, then tap **Go** to export or share one video — all on your device.

## What it is

- Free and open source: [github.com/kentcdodds/kody-video](https://github.com/kentcdodds/kody-video)
- No accounts, no clip uploads, no cross-site tracking
- Projects live in this browser's IndexedDB until you export, back up, or send them
- Installable PWA (Chromium, especially Android, is the primary target)

## How to use it

1. Open [kody.video](https://kody.video/) and allow the camera
2. Hold anywhere on the preview to record a clip; release to stop
3. Arrange, duplicate, delete, and trim clips on the filmstrip
4. Tap **Go** to export one video, then Share or Save

Photos can be added to the timeline as still clips. Desktop can record a screen or window as a regular clip.

## Kody Video Plus

A one-time $0.99 Stripe Payment Link. It removes the export watermark and unlocks six project slots, background music, landscape projects, optional location tagging, and send-to-another-device. Restore from the device that already has Plus (About → Use Plus on another device) with a short code or QR — there is no login.

## Support

Email [team@kody.video](mailto:team@kody.video) or [open a GitHub issue](https://github.com/kentcdodds/kody-video/issues/new).

See [About](/about), [Privacy](/privacy), [Terms](/terms), and [auth.md](/auth.md).
`,
  },
  about: {
    title: 'About — Kody Video',
    description:
      'Kody Video is a free, open-source, on-device clips camera for the web.',
    canonical: 'https://kody.video/about',
    body: `# About Kody Video

Kody Video is a free and open source clips camera. The whole app, including the export engine, lives at [github.com/kentcdodds/kody-video](https://github.com/kentcdodds/kody-video).

## See it in action

Kent demos record, arrange, and share in a minute and a half: [YouTube tour](https://youtube.com/shorts/JaUdPTHHk7A). [A video Kent made with Kody Video](https://x.com/kentcdodds/status/2084891368724533456).

## Inspired by OK Video

The hold-to-record interaction model is inspired by [OK Video](https://okvideo.app) by Pim Coumans. Kody Video is an independent project and is not affiliated with OK Video. The koala mascot comes from the KCD community: [kentcdodds.com/kody](https://kentcdodds.com/kody).

## Private by design

No accounts, no uploads, no cross-site tracking. Clips live in this browser's storage until you export and share them yourself.

The app's only own network traffic:

- Stripe checkout and purchase verification if you buy Plus
- Anonymous Sentry crash reports (error and stack trace — never media)
- Cookieless Fathom page-view counts
- The home-screen tour video from \`media.kody.video\` if you tap play
- A short-lived \`/api/sync\` matchmaking room if you tap Send to device (code + WebRTC descriptions, never clips)
- A short-lived Plus restore code if you share Plus with another device (session id only)

## Made for phones

Designed as a mobile camera app. Desktop has keyboard support (hold Space to record, F flip, T timer, E editor, P play).

## Backups

Every project can be saved as a \`.kodyvideo\` file (⋯ → Save backup). Plus can also Send to device; the other device opens [kody.video/receive](/receive). Restore a backup from the About page in the app, or drop the file anywhere.

## Support

[Open a GitHub issue](https://github.com/kentcdodds/kody-video/issues/new) or email [team@kody.video](mailto:team@kody.video).

A poisoned or stale app shell (hero with no project slots) can be diagnosed at [/api/diag](/api/diag) and repaired at [/api/recover](/api/recover). Recover never touches IndexedDB.

## Legal

[Privacy](/privacy) · [Terms](/terms) · [auth.md](/auth.md)
`,
  },
  privacy: {
    title: 'Privacy — Kody Video',
    description:
      'Kody Video keeps recordings on your device. No accounts, no uploads, no cross-site tracking.',
    canonical: 'https://kody.video/privacy',
    body: `# Privacy

Last updated: August 2026

## Everything stays on your device

All recordings, projects, and edits live in this browser's on-device storage (IndexedDB). Nothing is uploaded. There are no accounts, no cookies, and no cross-site tracking.

## Anonymous page-view counts

The app counts page views with [Fathom Analytics](https://usefathom.com), a privacy-first service: no cookies, no personal identifiers, no cross-site tracking, and nothing that requires a consent banner. We only ever see aggregate numbers like "how many people opened the app today".

## Anonymous crash reports

When the app itself breaks, an error report (the error message, a stack trace, browser and OS names, and which step failed) is sent to Sentry so bugs get found and fixed. Crash reports never contain your clips, audio, location, or any account identifier, and no IP-based user profile is kept.

## Send to another device

Kody Video Plus can send a project to another phone or computer that has the app open. A Cloudflare matchmaker introduces the two browsers (a short code plus the WebRTC connection description, which includes network addresses). Your clips never go to our servers — they travel device-to-device, encrypted. Rooms expire in minutes and are not stored as a library. Receiving a project is free and is the same as importing a backup.

## Camera and microphone

The camera and microphone are used only while the app is open, on the camera view. Nothing is ever streamed anywhere.

## Optional location tagging

Location tagging is an optional Plus feature and is off by default. When it is on, each new clip stores device coordinates locally. Exported videos omit location by default; Plus users can explicitly include it in MP4 metadata from the export sheet.

## Watermark removal purchase

The one-time Plus purchase is processed by Stripe on Stripe's pages — their privacy policy applies. The app's verification endpoint sees only the checkout session id, never your media or location. Sharing Plus with another device mints a short-lived restore code that maps to that same session id and expires in minutes.

## Exports and sharing

Exported or shared files leave the device only when you share or save them yourself.

## Deleting your data

Delete projects in the app, or clear this site's browsing data / uninstall the PWA. There is no server copy to delete.

## Questions

Email [team@kody.video](mailto:team@kody.video) or open an issue at [github.com/kentcdodds/kody-video](https://github.com/kentcdodds/kody-video).

See also [Terms](/terms) and [About](/about).
`,
  },
  terms: {
    title: 'Terms — Kody Video',
    description: 'Terms of use for the on-device Kody Video clips camera.',
    canonical: 'https://kody.video/terms',
    body: `# Terms

Last updated: July 2026

## Free to use, as is

Kody Video is free to use and runs entirely on your device. It is provided "as is" without warranty of any kind. Use it at your own risk — always keep copies of recordings you care about. Device storage can be cleared by the browser or OS.

## Your recordings are yours

You own your recordings entirely. The app claims no rights to any of your content.

## Kody Video Plus

Kody Video Plus is a one-time $0.99 purchase that unlocks watermark-free exports, optional location tagging, sending a project to another device, and up to six project slots (the free plan includes one project) for the browser profile where it is verified. You can restore the purchase on another device with a short code or QR from the device that already has Plus. Payments are handled by Stripe. For refunds or purchase trouble, email [team@kody.video](mailto:team@kody.video).

## Recording responsibly

Don't use the app to record people unlawfully. You are responsible for complying with local recording and consent laws.

## Liability

Liability is limited to the amount you paid for the app — at most $0.99.

## Changes and affiliation

These terms may change with the app; they are versioned in the [open-source repo](https://github.com/kentcdodds/kody-video). Kody Video is not affiliated with OK Video.

See also [Privacy](/privacy) and [About](/about).
`,
  },
  receive: {
    title: 'Receive a project — Kody Video',
    description:
      'Accept a Kody Video project sent from another device. Free. Clips never upload.',
    canonical: 'https://kody.video/receive',
    body: `# Receive a project

Open this page on the receiving device when someone taps **Send to device** (Plus). The two browsers pair with a short code or QR and the \`.kodyvideo\` project travels over a WebRTC DataChannel.

Receiving is free. Clips never land on Kody Video servers. If the devices cannot connect, use **Save backup** and import the \`.kodyvideo\` file instead.

There is no account. See [auth.md](/auth.md) and [About](/about).
`,
  },
  auth: {
    title: 'Authentication — Kody Video',
    description: 'Kody Video has no accounts. Plus is a one-time Stripe Payment Link.',
    canonical: 'https://kody.video/auth.md',
    body: `# Authentication

Kody Video has **no accounts**.

- No login, passwords, cookies, sessions, or OAuth
- Do not invent a sign-in flow, password reset, or "create an account" step
- Projects and clips live in this browser's IndexedDB (\`kody-video\`)
- There is no clip upload API and no user cloud library

## Kody Video Plus

Plus is a one-time $0.99 [Stripe Payment Link](https://buy.stripe.com/00wfZi71ibU30rk9hU2Ry07). After checkout, Stripe redirects to \`/unlocked?session_id=<CHECKOUT_SESSION_ID>\`. \`/api/verify-purchase\` checks that session server-side; the entitlement is then stored on the device. 100%-off promotion codes use the same verification.

Restore on another device from the device that already has Plus: About → **Use Plus on another device** shows a short code and QR. The new device opens [kody.video/unlocked](/unlocked) (same path shape as [kody.video/receive](/receive)) and types or scans the code. Legacy \`/unlocked?code=\` links still work. That mints a short-lived mapping to the same Stripe session — not a password. A checkout session id still works if you have one. Stripe receipt URLs do not include that session id.

## Other network calls

- \`/api/sync\` — short-lived send-to-device matchmaking (room code + WebRTC descriptions). Never media.
- \`/api/restore-codes\` — short-lived Plus restore codes (session id only, 30 minutes).
- \`/api/verify-purchase\` — Stripe session or restore-code check. Never media.
- \`/api/diag\` and \`/api/recover\` — on-device shell repair. Recover never touches IndexedDB.

See [Privacy](/privacy) and [About](/about).
`,
  },
}

export function pageIdForPath(pathname: string): AgentPageId | null {
  const path = pathname.replace(/\/+$/, '') || '/'
  switch (path) {
    case '/':
    case '/index.html':
    case '/app':
    case '/app.html':
      return 'home'
    case '/about':
    case '/about.html':
      return 'about'
    case '/privacy':
    case '/privacy.html':
      return 'privacy'
    case '/terms':
    case '/terms.html':
      return 'terms'
    case '/receive':
      return 'receive'
    case '/auth.md':
      return 'auth'
    default:
      return null
  }
}

function acceptQuality(accept: string | null, type: string): number {
  if (!accept) return 0
  let best = 0
  for (const part of accept.split(',')) {
    const [media, ...params] = part.split(';').map((token) => token.trim())
    if (media?.toLowerCase() !== type) continue
    const qParam = params.find((param) => param.toLowerCase().startsWith('q='))
    const quality = qParam ? Number(qParam.slice(2)) : 1
    if (Number.isFinite(quality) && quality > 0) best = Math.max(best, quality)
  }
  return best
}

/** True when text/markdown is present with q>0 and is not outranked by text/html. */
export function prefersMarkdown(accept: string | null): boolean {
  const markdown = acceptQuality(accept, 'text/markdown')
  if (markdown <= 0) return false
  return markdown >= acceptQuality(accept, 'text/html')
}

export function renderAgentMarkdown(id: AgentPageId): string {
  const page = PAGES[id]
  switch (id) {
    case 'home':
    case 'about':
    case 'privacy':
    case 'terms':
    case 'receive':
    case 'auth':
      return `---
title: ${page.title}
description: ${page.description}
url: ${page.canonical}
---

${page.body.trim()}\n`
    default: {
      const exhaustive: never = id
      throw new Error(`Unhandled agent page: ${String(exhaustive)}`)
    }
  }
}

export function agentMarkdownResponse(request: Request): Response | null {
  const method = request.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return null

  const url = new URL(request.url)
  const id = pageIdForPath(url.pathname)
  if (!id) return null

  const accept = request.headers.get('accept')
  if (id !== 'auth' && !prefersMarkdown(accept)) return null

  const body = renderAgentMarkdown(id)
  const headers = {
    'content-type': 'text/markdown; charset=utf-8',
    vary: 'Accept',
    'cache-control': 'public, max-age=3600',
    'x-markdown-tokens': String(Math.ceil(body.length / 4)),
    'content-signal': CONTENT_SIGNAL,
  }

  if (method === 'HEAD') return new Response(null, { status: 200, headers })
  return new Response(body, { status: 200, headers })
}
