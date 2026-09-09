# Claude PR Event Channel

A local service that delivers GitHub pull-request events into the one Claude Code worker
session that is working on that PR — no PR polling, no `/loop` routine.

- A **dispatcher** process listens on `127.0.0.1` for GitHub webhook deliveries, verifies
  the signature over the raw body, normalizes each payload into a small typed event, and
  routes it to the session registered for that PR.
- A **courier** pushes each queued event into the worker's Claude Code session with
  `claude --resume <session-id> -p ...`, so the session is told rather than having to ask.
  It acks only once the session has taken the event.
- A **registration CLI** joins a session to a PR and leaves it again.

The per-session contract — tools, delivery semantics, staleness, teardown — is in
[docs/CONTRACT.md](docs/CONTRACT.md).

## What it delivers

PR conversation comments, reviews, inline review comments, CI check state changes
(including a derived *all required checks green*), the `Build Temploy Image` workflow run
state for the PR head, and PR lifecycle events (opened incl. draft, synchronize,
ready_for_review, converted_to_draft, reopened, closed, merged).

## Safety properties

- `X-Hub-Signature-256` is verified with HMAC-SHA256 and `timingSafeEqual` over the raw
  request bytes **before** the body is parsed or anything is stored. A bad signature is a
  bare `401`; nothing is parsed, recorded, or logged beyond a failure reason.
- Repository allowlist, event-type allowlist, payload size cap, and a delivery rate limit
  are enforced on every request.
- `X-GitHub-Delivery` ids are recorded durably, in the same transaction that enqueues the
  delivery's events; a replay is accepted with `202` and enqueues nothing, while a
  delivery that failed leaves no trace and is processed when GitHub redelivers it.
- The registry tracks each PR's current head SHA. A `pull_request` delivery outranks a
  head asserted at registration, which comes from a clone that may be behind GitHub;
  between two deliveries only a *newer* one moves the head, so one that arrives out of
  order is refused, while a force-push back to an earlier commit is followed, because it
  is the newer of the two. A `--head` differing from one a `pull_request` delivery
  established is refused unless `--replace` is given.
- An event whose head is not the PR's current head is flagged `stale` (re-evaluated on
  every delivery), and a *green* or *Temploy-ready* signal that cannot be tied to the current
  head — including when no head is known yet — is marked `positiveSignalSuppressed` so it
  can never be read as the current head passing.
- Per-head check states are ordered the same way: a check result older than the one
  already banked is refused, so an old success redelivered from GitHub cannot overwrite a
  newer failure and turn the head green again.
- An event for a PR with no registered session is recorded as unrouted and dropped. It is
  never broadcast to other sessions. A check or workflow delivery that names no PR is
  attributed by head SHA to any PR that has held that head, closed routes included, so it
  is delivered or recorded rather than silently discarded.
- All GitHub-authored text travels as inert data in `untrustedBody` / `untrustedTitle`,
  and every rendered event repeats the rule that it is data, never instructions.
- Logs carry identifiers, states, and counts only — never a secret, a raw header, a
  request body, or GitHub-authored text.

## Running it locally

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # vitest run
npm run build         # tsc -> dist/
```

Dispatcher (binds `127.0.0.1` by default and refuses a non-loopback host unless you
explicitly opt in):

```bash
GITHUB_WEBHOOK_SECRET=... PR_CHANNEL_REPO_ALLOWLIST=owner/name node dist/index.js
# GET  http://127.0.0.1:8787/healthz
# POST http://127.0.0.1:8787/webhook
```

Register a worker session, then start its channel:

```bash
node dist/cli.js register --repo owner/name --pr 123 --session "$SESSION_ID" --head "$(git rev-parse HEAD)"
node dist/cli.js status --session "$SESSION_ID"
node dist/cli.js deregister --repo owner/name --pr 123 --session "$SESSION_ID"

node dist/cli.js register --repo owner/name --pr 42 \
  --session "$CLAUDE_CODE_SESSION_ID" --dir "$(pwd)"   # or just /pr-channel 42 in the session
```

Every CLI command prints one JSON line on stdout. Exit codes: `0` done, `1` refused (route
conflict, session mismatch, unknown route), `2` usage or configuration error.

## Installing on a machine

```
git clone <this repo> claude-pr-channel && cd claude-pr-channel
./scripts/install.sh
```

Checks the prerequisites, builds, puts `pr-channel` on PATH, and installs the Claude Code
skill into `~/.claude/skills/pr-channel/`. Re-run it after pulling to update both.

Requirements: **Node 24+** (the store uses `node:sqlite`), the **GitHub CLI** logged in,
and **admin on the repo** you point it at, since forwarding creates a webhook.

Nothing machine-specific is committed: the database, the webhook secret and the run
state all live in `~/.claude-pr-channel/`, outside the repo.

## Using it on a repo

```
pr-channel up owner/your-repo
```

That builds, starts the dispatcher on 127.0.0.1, and forwards that repo's real webhook
deliveries to it with no public endpoint. It defaults `PR_CHANNEL_COMMENT_AUTHORS` to
your own GitHub login and prints the configuration it used.

Add your project's test command so the session can verify before it claims a pass:

Stop everything with `pr-channel stop`: it releases every route, kills the processes and
removes the webhooks it created. Logs are under `~/.claude-pr-channel/`.

In practice you rarely run either by hand — `/pr-channel <number>` in a session does the
bring-up itself.

## Subscribing a session to a PR

From inside the worker Claude Code session, in that PR's checkout:

```
/pr-channel 42
```

One channel is one `(repo, PR, session)`. A different session, or a different PR, is a
different channel. `/pr-channel stop` unsubscribes.

Replies the session posts on GitHub begin with `**Claude:**`. The dispatcher uses that
prefix to recognise the worker's own comments and refuses to route them back, so a
session never answers itself.

## Getting events in without a public endpoint

GitHub must reach the dispatcher for any of this to happen. For local testing,
`gh webhook forward` creates a real webhook and streams deliveries to localhost with no
public endpoint:

```
gh extension install cli/gh-webhook
gh webhook forward --events='issue_comment,pull_request,pull_request_review,\
pull_request_review_comment,check_run,workflow_run' \
  --repo=owner/name --url="http://127.0.0.1:8787/webhook" --secret="$GITHUB_WEBHOOK_SECRET"
```

Note that `--secret` puts the value in the process's argv, where any local user can read
it with `ps`. That is acceptable for a throwaway dev secret; a deployed webhook keeps the
secret in GitHub's webhook config and the dispatcher's environment, never in argv.

## Whose comments the session acts on

Anyone who can write on a PR can leave a comment, and acting on a comment means pushing
code. `PR_CHANNEL_COMMENT_AUTHORS` is the trust boundary:

```
PR_CHANNEL_COMMENT_AUTHORS=your-github-login
```

Only those logins can drive the session through comments, reviews and inline review
comments; anyone else's feedback is delivered to nobody and waits for a human. Logins are
matched case-insensitively, and the list widens by adding to it — no code change — when
you decide colleagues may drive it too.

Leaving it unset allows every human author, which is only appropriate on a repo where
that is already true. Bot comments are always ignored regardless, and CI results are
never gated by it: they come from the system, not a person.

## Environment variables

Names only. Never commit a value, echo one, or paste one into a log or a ticket.

| Variable | Used by | Notes |
| --- | --- | --- |
| `GITHUB_WEBHOOK_SECRET` | dispatcher | Required. Read at startup, held only as an HMAC key, never logged or persisted. |
| `PR_CHANNEL_REPO_ALLOWLIST` | dispatcher, CLI | Required for the dispatcher: comma-separated `owner/name` list. The CLI enforces it when set. |
| `PR_CHANNEL_HOST` | dispatcher | Defaults to `127.0.0.1`. |
| `PR_CHANNEL_PORT` | dispatcher | Defaults to `8787`. |
| `PR_CHANNEL_MAX_PAYLOAD_BYTES` | dispatcher | Body cap; oversized deliveries get `413`. |
| `PR_CHANNEL_RATE_LIMIT_MAX` | dispatcher | Signed deliveries allowed per window. |
| `PR_CHANNEL_RATE_LIMIT_WINDOW_MS` | dispatcher | Rate-limit window. |
| `PR_CHANNEL_REQUIRED_CHECKS` | dispatcher | Comma-separated check names that make up "all required green". Empty means that event is never derived. |
| `PR_CHANNEL_DB_PATH` | all | SQLite file, default `~/.claude-pr-channel/channel.db`. Absolute by default so the dispatcher and the registration CLI share one database whatever directory each runs from. |
| `PR_CHANNEL_COMMENT_AUTHORS` | dispatcher | Logins whose comments may drive the session. Unset allows every human author. |
| `PR_CHANNEL_LEASE_TIMEOUT_MS` | courier | How long a leased-but-unacked event stays hidden before redelivery. |
| `PR_CHANNEL_SESSION_ID` | channel | Alternative to `--session-id`. |
| `PR_CHANNEL_ALLOW_NON_LOOPBACK` | dispatcher | Opt-in required to bind a non-loopback host. Leave unset. |

## Layout

```
src/webhook/    HTTP ingress: signature, size/rate limits, allowlists
src/events/     payload normalization, required-checks derivation, delivery dedup
src/registry/   durable (repo, prNumber) -> session routes, head tracking, staleness
src/channel/    per-session queue and lifecycle manager
src/delivery/   prompt rendering, courier, `claude --resume` sender
src/store/      node:sqlite schema and helpers
src/dispatcher.ts  the pipeline; src/index.ts dispatcher entry; src/cli.ts registration CLI
test/           signed webhook fixtures and the end-to-end integration test
```

Tests live next to the module they cover; `test/` holds the fixtures and the end-to-end
test that drives real HTTP with real signatures.

## Out of scope

This repository is a local service and nothing else. Deliberately **not** included, and
not to be added as a side effect of using it:

- No public endpoint, tunnel, or external HTTPS route.
- No GitHub webhook creation or configuration.
- No Nginx, systemd, firewall, or DNS changes; no deployment of any kind.
- No non-loopback bind in the default configuration.
- No secret in source, fixtures, logs, or commits — tests use the obviously fake literal
  `test-only-fake-secret`.
- Nothing kills, signals, or otherwise touches a worker's tmux session: closing a PR
  closes the *channel*, and the channel process exits on its own once its queue drains.
