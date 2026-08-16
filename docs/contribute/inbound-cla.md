# Inbound CLA for external contributions

- **Status:** accepted
- **Date:** 2026-08-16

## Context

This repository is Fair Source under [FSL-1.1-ALv2](../../LICENSE). Copyright
is held by Kent C. Dodds as the sole Licensor. FSL's competing-use
restriction, two-year Apache 2.0 conversion, and any later relicensing or
commercial license only work cleanly when one party can speak as "We" for the
whole tree.

GitHub's inbound-same-license rule is not enough here. It licenses a patch
under FSL, but it does not grant relicensing rights, a contributor patent
license, or a warranty that the contributor (or their employer) actually owns
the patch. A Developer Certificate of Origin records provenance only.

The repo is public. History is almost entirely Kent C. Dodds and allowlisted automation, with at least one outside human commit.

This matches the inbound CLA process on
[kody](https://github.com/kentcdodds/kody).

## Decision

Require a signed **inbound Contributor License Agreement** (not assignment)
before merging a pull request that includes commits from anyone other than
the Licensor or an allowlisted bot.

The contributor keeps copyright. They grant Kent C. Dodds a perpetual,
worldwide, irrevocable, sublicensable copyright and patent license, including
the right to relicense the contribution under FSL-1.1-ALv2, Apache 2.0, and
any commercial or other terms the Licensor offers.

How it works:

- **Scope.** This git repository only.
- **Who signs.** Every GitHub identity that authors a commit on the pull
  request, unless that identity is `kentcdodds`, `kody-bot`, a `*[bot]`
  or `app/*` account, or an email listed as Licensor-owned in
  [`.github/cla-signers.json`](../../.github/cla-signers.json).
- **Which form.** [Individual CLA](../legal/individual-cla.md) by default.
  [Entity CLA](../legal/entity-cla.md) when an organization owns the work.
- **How they sign.** Read the CLA, then comment:
  `I have read the CLA and I hereby sign the CLA`. A maintainer records the
  GitHub username in `.github/cla-signers.json` on `main`.
- **Enforcement.** The `CLA` workflow reads signers from `main` (never
  from the pull request head) and fails closed. No trivial-contribution
  exception.

## Consequences

- The Licensor stays one party for FSL, the Apache conversion, relicensing,
  and enforcement.
- Outside pull requests take one extra maintainer step (record the signer on
  `main`).
- Revisit if the Licensor becomes a company, if counsel revises the CLA
  text, or if contribution volume justifies hosted click-to-sign.
