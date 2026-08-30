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

Restore on another device from the device that already has Plus: About → **Use Plus on another device** shows a short code and QR. The new device opens `/unlocked` (same path shape as `/receive`) and types or scans the code — `/unlocked/ABC234`. Legacy `/unlocked?code=` links still work. That mints a short-lived mapping to the same Stripe session — not a password. A checkout session id still works if you have one. Stripe receipt URLs do not include that session id.

## Other network calls

- `/api/sync` — short-lived send-to-device matchmaking (room code + WebRTC descriptions). Never media.
- `/api/restore-codes` — short-lived Plus restore codes (session id only, 30 minutes).
- `/api/verify-purchase` — Stripe session or restore-code check. Never media.
- `/api/diag` and `/api/recover` — on-device shell repair. Recover never touches IndexedDB.

See [Privacy](/privacy) and [About](/about).
