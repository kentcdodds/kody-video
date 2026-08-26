---
name: ship-pr
description: >
  Babysit a PR: iterate with AI reviewers and CI until green, get it ready,
  optionally squash-merge as Kody and watch the deploy, then send a Discord
  summary. Medium risk waits for AI reviewer(s) and addresses valid feedback.
  Use when a pull request needs to be shepherded to done.
---

# Ship PR

## Risk → merge authority

Self-assess; user policy overrides.

**Kody Video default:** ship when ready. Do not wait for a separate "Go"
once CI is green and Bugbot is clear (valid feedback addressed). CodeRabbit
rate-limits do not block. High-risk work, or an explicit pause, still waits.

- **Low** — green CI; nits ignorable; squash-merge when policy allows.
- **Medium** — wait for AI reviewer(s); address **valid** feedback (ignore
  insignificant nits / already-fixed / wrong); then merge when policy allows.
- **High** — leave ready-for-review unless the user granted merge authority.

## AI reviewers

Prefer **Cursor Bugbot** (`Cursor Bugbot` check / `cursor[bot]` review comments).
Trigger with `bugbot run` or `@cursor review` on the PR if it has not started.

**CodeRabbit:** if it is rate-limited, errored, or otherwise unavailable, **do not
wait** on it for low/medium risk — proceed with Bugbot + CI. Only wait on
CodeRabbit when the change is **high** risk (or the user explicitly asks).

## Loop

1. Mark ready — `kody:@kentcdodds/github/pr/set-review-status`
   `{ prUrl, status: 'ready' }` (or owner/repo/prNumber).
2. Wait for CI — `gh pr checks` (or compose `loop-on-ci` / `fix-ci`).
3. Fix failures; for **medium+**, wait on AI reviewer(s) (Bugbot first; see
   above for CodeRabbit) and address valid feedback. Rebase only when actually
   unmergeable.
4. Green + (medium+: valid feedback cleared) → break.
5. Push → repeat.

## Gates ≠ CI

Blocked on soak / parity CHECK / calendar gate → **end the run** and schedule a
wake (Kody `job_schedule` + `createRun`). Don't sleep-poll or code-thrash an
intentional time window.

Batch related expand steps into fewer PRs when risk posture allows.

## Merge / deploy

When policy + risk allow: squash-merge via `kody:@kentcdodds/github/pr/merge`
`{ prUrl, mergeMethod: 'squash' }`, watch deploy. Useful: `pr/get-checks`,
`request`, `graphql` on the same package.

## Done → Discord

Always summarize (merged or not) by calling
`kody:@kentcdodds/discord/send-shipped-pr` with structured fields. Do **not**
use raw `post-message` and do **not** compute or guess token cost — the export
fetches the billed Cursor Cloud Agent usage and formats the cost line.

**agentId (required):**
- In a Cursor Cloud Agent VM, read it from the metadata socket:
  curl -fsS --unix-socket "${CURSOR_AGENT_SOCKET:-/run/cursor/api.sock}" http://cursor-agent/v1/meta-data/agent/id
- Otherwise pass the `bc-` id from the agent URL you were launched as
  (https://cursor.com/agents/{id}).

```javascript
import sendShippedPr from 'kody:@kentcdodds/discord/send-shipped-pr'

export default async function main() {
	return sendShippedPr({
		agentId, // bc- id from the metadata socket or launch URL
		title: 'PR title',
		summary: 'What shipped / parked / blocked and why.',
		prUrl: 'https://github.com/owner/repo/pull/1',
		repo: 'owner/repo',
		extras: ['CI green', 'preview verified'],
		status: 'Shipped', // or 'Parked' | 'Blocked'
	})
}
```
