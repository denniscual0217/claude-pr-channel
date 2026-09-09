# Claude PR Event Channel

Delivers GitHub pull-request events into the Claude Code session working on that PR, so
the session acts on them without being asked: a review comment gets addressed and
answered, a red build gets fixed and pushed.

No polling and no public endpoint — a real GitHub webhook is forwarded to a local
dispatcher.

## How it works

1. A local dispatcher receives webhook deliveries on `127.0.0.1`.
2. It verifies `X-Hub-Signature-256` over the raw body before parsing anything.
3. It normalizes and deduplicates the delivery, then routes it to the one session
   registered for that PR, storing it durably.
4. That session's channel — an MCP server Claude Code spawns for it — pushes the event in
   as a `<channel>` event, and acks it only once the push lands.

One channel is one `(repo, PR, session)`. Different PRs and different sessions are
different channels; they run in parallel and cannot cross-talk.

## Install

```
git clone <this repo> claude-pr-channel && cd claude-pr-channel
./scripts/install.sh
```

Builds, puts `pr-channel` on PATH, installs the Claude Code skill, and writes a config
file. Re-run after pulling to update. It checks the prerequisites and fails with a clear
message rather than half-installing.

### Requirements

| Need | Why | Check |
| --- | --- | --- |
| **Node 24+** | The store uses the built-in `node:sqlite` | `node -v` |
| **GitHub CLI, logged in** | Creates and forwards the webhook | `gh auth status` |
| **`cli/gh-webhook` extension** | Webhook forwarding — the installer adds it | `gh extension list` |
| **Admin on the target repo** | Creating a webhook requires it | `gh api repos/OWNER/NAME --jq .permissions.admin` |
| **Git** | The session commits and pushes | `git --version` |

**You do not need to install SQLite.** The database is Node 24's built-in `node:sqlite`
— no `sqlite3` package, no native module, no compiler or build toolchain. The only
runtime dependencies are `@modelcontextprotocol/sdk` and `zod`, both pure JavaScript.

Nothing else is assumed about the machine. There is no daemon to register, no port to
open, and no reverse proxy: the dispatcher binds `127.0.0.1` and GitHub reaches it
through `gh webhook forward`.

### Updating

```
pr-channel update
```

Pulls the branch you are on and reinstalls: CLI, skill, channel registration, and any
config settings your file is missing. Pulling alone is not enough — the skill and the
channel registration live outside the checkout, so they only change when you reinstall.

Restart any open sessions afterwards: a session loads the skill and attaches its channel
at startup.

### Removing

```
./scripts/uninstall.sh           # stop everything, remove webhooks, CLI, skill, channel
./scripts/uninstall.sh --purge   # and delete the database, config and secret
```

## Use

Start the session with the channel attached, inside the checkout for the PR:

```
claude --dangerously-load-development-channels server:pr-channel
```

Then:

```
/pr-channel 123        # bind this session to PR 123
/pr-channel stop       # unsubscribe
```

That is the whole workflow. The skill starts the dispatcher if needed, creates the
repo's webhook, picks the worktree holding that branch (creating one if none does), and
registers the session.

When you are done:

```
pr-channel stop        # releases every route, stops everything, removes its webhooks
```

`pr-channel up <owner/repo>`, `register`, `deregister` and `status` are available if you
would rather drive it by hand.

## What reaches your session

Subscribed webhook events: `issue_comment`, `pull_request`, `pull_request_review`,
`pull_request_review_comment`, `check_run`, `workflow_run`. Everything else GitHub emits
is never sent here at all.

Of those, a session is only interrupted for what it can act on:

| Delivered | Suppressed |
| --- | --- |
| A comment, review or inline review comment from an allowed author | Bot comments, your own `**Claude:**` replies, reviews with an empty body, authors outside `PR_CHANNEL_COMMENT_AUTHORS` |
| A check that **finished badly** | `queued` and `in_progress` transitions, and passing checks — a push with twenty checks fires sixty of these |
| All required checks green (derived once per head) | The individual successes that add up to it |
| `Build Temploy Image` finishing | Its pending states, and every other workflow |
| PR opened, synchronized, ready for review, converted to draft, reopened, closed, merged | Labels, assignments, review requests, edits |

`PR_CHANNEL_CI_EVENTS` widens the CI rule: `failures` (default), `completed` to include
passing checks, `all` to include pending transitions. Suppressed events are still queued
and acked — they are recorded, they just do not interrupt.

## What it delivers

PR conversation comments, reviews, inline review comments, CI check results, the
`Build Temploy Image` workflow state, and PR lifecycle changes (opened, synchronized,
ready for review, converted to draft, reopened, closed, merged).

Not delivered: bot comments, reviews submitted with an empty body, the session's own
replies, and comments from anyone outside `PR_CHANNEL_COMMENT_AUTHORS`.

## Safety

- The signature is verified over the raw body with a timing-safe comparison before the
  payload is parsed, stored or logged.
- **`PR_CHANNEL_COMMENT_AUTHORS`** is a trust boundary, not a filter: acting on a comment
  means pushing code, so only these logins can drive a session. Defaults to the
  authenticated `gh` user. CI results are never gated by it.
- Events arrive in the session you launched, so they run with **that session's own
  permission mode** — this service no longer constrains it. Untrusted comment text reaches
  a session with your permissions, so do not run a PR-bound session with
  `--dangerously-skip-permissions`.
- Comment and review text is carried as clearly-labelled untrusted data, fenced with the
  event id so it cannot impersonate the service.
- An event for a superseded head is flagged stale and can never report the current head
  as green.
- The server binds loopback only; the webhook secret is never logged or committed.

## Configuration

Settings live in `~/.claude-pr-channel/config` as `KEY=VALUE` lines, created by the
installer with everything commented out. Every subcommand reads it, so the dispatcher and
the registration CLI can never disagree.

```
# ~/.claude-pr-channel/config
PR_CHANNEL_COMMENT_AUTHORS=your-login
```

Anything already in the environment wins, so a one-off override works too:

```
PR_CHANNEL_PORT=9001 pr-channel up owner/repo
```

`pr-channel config` prints the file and the values in effect.

Every path is configurable; the defaults keep all state out of the repo.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PR_CHANNEL_RUN_DIR` | `~/.claude-pr-channel` | Database, webhook secret, logs, run state |
| `PR_CHANNEL_DB_PATH` | `$PR_CHANNEL_RUN_DIR/channel.db` | SQLite file (absolute, so the CLI and dispatcher always agree) |
| `PR_CHANNEL_BIN_DIR` | `/usr/local/bin` or `~/.local/bin` | Where `install.sh` links `pr-channel` |
| `PR_CHANNEL_SKILL_DIR` | `~/.claude/skills` | Where `install.sh` installs the skill |
| `PR_CHANNEL_PORT` | `8787` | Dispatcher port on `127.0.0.1` |
| `PR_CHANNEL_COMMENT_AUTHORS` | authenticated `gh` user | Logins whose comments may drive a session |
| `PR_CHANNEL_REQUIRED_CHECKS` | — | Check names that make up "all required green" |
| `PR_CHANNEL_CI_EVENTS` | `failures` | Which CI events interrupt a session: `failures`, `completed`, `all` |
| `PR_CHANNEL_REPO_ALLOWLIST` | repos you registered | Repositories the dispatcher accepts |
| `PR_CHANNEL_LEASE_TIMEOUT_MS` | `60000` | How long an unacked event stays hidden before redelivery |
| `GITHUB_WEBHOOK_SECRET` | generated per machine | HMAC secret, kept `0600` in the run directory |

## Out of scope

Public deployment, TLS termination, and reverse-proxy or systemd configuration. Webhook
delivery uses `gh webhook forward`, which needs no inbound port.

Note that `gh webhook forward` takes the secret on its command line, where local users
can read it via `ps`. A deployed webhook keeps the secret in GitHub's configuration and
the dispatcher's environment instead.

## Development

```
npm test           # 291 tests
npm run typecheck
```
