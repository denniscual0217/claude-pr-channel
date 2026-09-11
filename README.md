# claude-pr-channel

A Claude Code **plugin** that binds one session to one GitHub pull request. The session's
own MCP server owns a webhook for that PR, verifies every delivery, and pushes the events
worth acting on straight into the conversation as `<channel source="pr-channel">` turns.

There is no daemon, no database, and no machine-wide state. Tracking is a running
process: when the session goes, the webhook goes with it.

```
claude (session) → bun server.ts (channel) → gh webhook forward
                                           → bun src/github/janitor.ts
```

## Install

Requires [Bun](https://bun.sh), the [GitHub CLI](https://cli.github.com) authenticated as
a user with **admin** on the repository, and its webhook extension:

```
gh extension install cli/gh-webhook
```

Launch a session with the plugin and the development-channels flag. A private plugin is
not on the approved channels allowlist, so `--channels` alone will not load it:

```
# once per machine
claude plugin marketplace add /path/to/claude-pr-channel
claude plugin install pr-channel@pr-channel-local

# per session, in the PR's worktree
claude --dangerously-load-development-channels plugin:pr-channel@pr-channel-local
```

The session's banner should mention `messages from server:pr-channel inject directly in
this session`. Without that line, nothing will ever arrive.

## Use

The plugin's skills are namespaced by its name:

- `/pr-channel:track 3053` — or a PR URL, `owner/name#3053`, or nothing at all to use the
  PR for the current branch.
- `/pr-channel:untrack` — stop, and delete the webhook.

Behind those, the channel server exposes three tools:

| tool | what it does |
| --- | --- |
| `track` | Resolve the PR with `gh`, generate a webhook secret in memory, start a loopback listener on an ephemeral port, spawn `gh webhook forward`, confirm the hook id, and begin delivering. Blocks until the hook is confirmed, so success means events are flowing. |
| `untrack` | Stop the listener and the forwarder, delete the webhook, and report the counters. |
| `status` | Report the PR, head sha, hook id, the **live** forwarder state, the listener port and the delivery counters. `verify: true` also asks GitHub whether the hook still exists. |

`track` accepts `pr`, `repo`, `ci_events`, `required_checks`, `comment_authors`,
`bot_comments` and `replace`.

## What is delivered

Only what a session can act on. Everything else is counted and dropped.

| event | delivered |
| --- | --- |
| PR comment, review, inline review comment | Yes, unless the author is outside `comment_authors` (default: the `gh` login) or the body starts with `**Claude:**` |
| Review with no body | No — it is the envelope around inline comments that arrive on their own |
| CI check | `completed` (default) every finished check; `failures` only the ones that finished badly; `all` every transition |
| All required checks green | Derived from `required_checks`, announced once per head |
| Temploy image build | Only a successful one; a failure is not this session's to chase |
| PR lifecycle (opened, synchronize, draft, ready, closed, merged) | Yes; `closed`/`merged` is delivered and then stops tracking |
| Anything for another PR in the repo | No — counted as `dropped_other_pr` |
| A green for a head the PR has already left | Delivered as history, flagged stale, never as a green light |

## Safety

- The listener binds `127.0.0.1:0`. Nothing off this machine can reach it.
- Every delivery is HMAC-verified against a secret generated per `track`, over the raw
  bytes, before anything parses the body. The secret is never written to a file, a log or
  a marker; `gh webhook forward` takes it on its own argv, which is visible in `ps` to
  local users and cannot be avoided without replacing gh-webhook.
- A delivery for any repository but the tracked one is refused with 403.
- Comment and review text reaches the model fenced and labelled untrusted.

## Cleanup

Every path leaves nothing behind, and every delete is idempotent — a 404 counts as done.

| what happens | what cleans up |
| --- | --- |
| `untrack`, or the PR is merged or closed | The channel: listener, `gh`, DELETE hook, marker removed |
| `gh` created a hook and died before anything confirmed it (a failed dial, a restart in progress) | The channel, at teardown and before every respawn: it lists the repository again and deletes the one hook that appeared since `gh` was launched |
| Session exits, stdin closes, SIGTERM/SIGINT/SIGHUP (including `tmux kill-session`) | The channel, same sequence |
| A DELETE fails (a blip during a restart is the common one) | Whoever gets there first: the id is kept, retried at the next respawn and at teardown, sent to the janitor, and named by the marker for the next sweep |
| The channel is SIGKILLed | The janitor: its stdin pipe closes and its parent pid changes, so it kills `gh` and deletes the hook |
| The channel **and** the janitor are killed together, or the machine crashes | The next `track` on this machine: it sweeps the markers left behind |

Markers live under `${XDG_CACHE_HOME:-~/.cache}/claude-pr-channel/hooks/`. They name the
hook, the `gh` pid, the janitor pid and any hook whose DELETE failed, and nothing else —
never a secret. The sweep only ever touches a hook that has a marker whose janitor is
dead, which is what keeps it from disturbing another live session, another machine, or a
hook a person created by hand.

Nothing is deleted that this session cannot show is its own. A ping signed with this
session's secret is the proof; failing that, a single hook that appeared since `gh` was
launched is unambiguous, because `gh` creates exactly one. Once a hook id is confirmed,
that guess is never made again for the launch it belongs to: deleting the confirmed hook
is the whole job, and anything else on the repository is another session's. When two or
more unconfirmed hooks appeared, one of them may be another session's, so **none** is
deleted: the ids are reported by `track` or `untrack` for a person to judge, with the
`gh api -X DELETE` line to remove them. A hook left that way is a leak this session
names; a hook deleted that way would silently stop another session's events.

## What is intentionally not recovered

- **Events from before `track`.** Nothing is replayed; look them up with `gh` if they
  matter.
- **Events during a forwarder restart.** There is no queue. A restart window loses what
  arrives in it, and `status` shows `restarting`.
- **A failed push into the session.** Counted as `notify_failed`, never retried.
- **Two sessions on one PR.** Both are tracked, both get everything, and neither knows
  about the other. Neither ever deletes the other's webhook, at the cost of leaving a
  webhook it cannot prove is its own in place, named, for a person to remove.

## Configuration

Tool arguments win; these are the defaults.

| variable | meaning |
| --- | --- |
| `PR_CHANNEL_COMMENT_AUTHORS` | Logins whose comments may reach the session. Default: the `gh` login at `track` time |
| `PR_CHANNEL_BOT_COMMENTS` | `handle` (default) or `ignore` |
| `PR_CHANNEL_CI_EVENTS` | `completed` (default), `failures`, `all` |
| `PR_CHANNEL_REQUIRED_CHECKS` | Comma-separated check names for all-required-green |
| `PR_CHANNEL_MAX_PAYLOAD_BYTES` | Delivery size cap, default 1 MiB |
| `PR_CHANNEL_RATE_LIMIT_MAX` / `_WINDOW_MS` | Signed deliveries per window, default 120/60s |
| `PR_CHANNEL_CACHE_DIR` | Marker directory override (used by the tests) |
| `PR_CHANNEL_SWEEP` | `off` skips the startup sweep |

## Development

```
bun install
bun test
```

The suite is offline. `test/setup.ts` puts a `gh` shim first on `PATH` and the shim exits
99 unless a test configured it, so no test can reach GitHub.
