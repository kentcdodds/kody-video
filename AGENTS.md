# AGENTS.md

Kody Video is a mobile-first, on-device PWA "clips camera": hold to record clips, arrange/trim them on a filmstrip timeline, then export/share one video file (see `README.md` for architecture).

## Shipping

Ship ready PRs by default: once CI is green and Bugbot is clear (valid
feedback addressed), squash-merge and watch the deploy. Do not wait for a
separate "Go" unless the change is high-risk or the user pauses. CodeRabbit
rate-limits do not block. Follow `.cursor/skills/ship-pr/SKILL.md`.

## Cursor Cloud specific instructions

Contributor and cloud-agent docs live in `docs/contribute/`:

- [`environment.md`](docs/contribute/environment.md) — required Node version (`>=24.3.0`) and dependency/install caveats.
- [`running-and-testing.md`](docs/contribute/running-and-testing.md) — dev server, lint, unit, and e2e/smoke test commands.
- [`manual-camera-testing.md`](docs/contribute/manual-camera-testing.md) — driving the camera/record/export flow in a headless VM.
- [`inbound-contributions.md`](docs/contribute/inbound-contributions.md) — inbound CLA for outside pull requests.
