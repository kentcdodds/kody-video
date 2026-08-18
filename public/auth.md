---
title: Authentication — Kody Video
description: Kody Video has no accounts. Plus is a one-time Stripe Payment Link.
url: https://kody.video/auth.md
---

# Authentication

Kody Video has **no accounts**.

- No login, passwords, cookies, sessions, or OAuth
- Do not invent a sign-in flow, password reset, or "create an account" step
- Projects and clips live in this browser's IndexedDB (`kody-video`)
- There is no clip upload API and no user cloud library

## Kody Video Plus

Plus is a one-time $0.99 [Stripe Payment Link](https://buy.stripe.com/00wfZi71ibU30rk9hU2Ry07). After checkout, Stripe redirects to `/unlocked?session_id=<CHECKOUT_SESSION_ID>`. `/api/verify-purchase` checks that session server-side; the entitlement is then stored on the device. 100%-off promotion codes use the same verification.

Restore on another device with **Already paid?** (export sheet or a locked slot). That is the same Stripe session, not a password.

## Other network calls

- `/api/sync` — short-lived send-to-device matchmaking (room code + WebRTC descriptions). Never media.
- `/api/diag` and `/api/recover` — on-device shell repair. Recover never touches IndexedDB.

See [Privacy](/privacy) and [About](/about).
