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
`bot_comments` and `replace`. The four filters override the matching keys in the
[config file](#configuration) for that one PR.

## What is delivered

Only what a session can act on. Everything else is counted and dropped.

| event | delivered |
| --- | --- |
| PR comment, review, inline review comment | Yes, unless the author is outside `comment_authors` (default: the `gh` login) or the body starts with `**Claude:**` |
| Review with no body | No — it is the envelope around inline comments that arrive on their own |
| CI check | `completed` (default) every finished check; `failures` only the ones that finished badly; `all` every transition |
| All required checks green | Derived from `required_checks`, announced once per head |
| Deploy workflow (`events.deployWorkflow`, off by default) | Only a successful run; a failure is not this session's to chase |
| PR lifecycle (opened, synchronize, draft, ready, reopened, closed, merged) | Yes; `closed`/`merged` is delivered and then stops tracking |
| Other pull_request actions (labeled, assigned, review_requested, edited, …) | Only once turned on under `events.lifecycle`; the label, assignee, reviewer or milestone it names is delivered as untrusted text |
| Anything for another PR in the repo | No — counted as `dropped_other_pr` |
| A green for a head the PR has already left | Delivered as history, flagged stale, never as a green light |

## Editing the configuration

The file is plain JSON and meant to be edited by hand. There is also a local editor:

```
bun run config
```

It serves a form on `127.0.0.1` — built from the same JSON Schema the plugin validates
against, so an option added to the config appears in the form without anyone updating the
UI. A **Raw JSON** tab edits the file directly, and switching tabs carries your edits
across rather than dropping them.

Saving validates through the plugin's own loader, so the editor cannot write a file the
plugin would then refuse at startup; the error names the key, what was wrong and what was
expected. Writes go through a temporary file and a rename, so an interrupted save leaves
the previous config intact.

### Keeping it running

Started by hand, the editor dies with the shell that started it — which is awkward when
the device you edit from cannot restart it. `packaging/pr-channel-config-ui.service`
installs it as a systemd unit that comes back on reboot and asks Tailscale for the
address to bind at each start:

```sh
sed -e "s|@BUN@|$(command -v bun)|" -e "s|@REPO@|$PWD|" \
  packaging/pr-channel-config-ui.service > /etc/systemd/system/pr-channel-config-ui.service
systemctl daemon-reload && systemctl enable --now pr-channel-config-ui
```

If Tailscale is unavailable the address comes back empty and the editor binds loopback,
so a VPN outage makes it unreachable rather than public. The unit also sets `HOME`,
without which neither the editor nor the plugin can say where the configuration file
lives.

Changes apply when a channel next starts. A session already tracking keeps the settings it
began with.

## Security

Read this before pointing it at a repository you care about.

### The model acts on text other people can write

This is the risk that matters. A PR comment is untrusted input, and it reaches a Claude
Code session that can edit files, run commands and push. The event carries that text
fenced and labelled untrusted, and the session is told to weigh it as a request rather
than obey it — but that is a mitigation, not a boundary. Prompt injection is not a solved
problem, and anyone who can comment on the PR is speaking to your agent.

Three things keep the blast radius small, and you should keep all three:

- **`authors.mode` defaults to `operator`** — you alone, the account `gh` is
  authenticated as. Widen it deliberately (`"mode": "listed"` and one login at a time in
  `authors.allow`), and understand that everyone you add can ask your session to change
  code.
- **Automated reviewers are allowed by default** because their findings are useful. A bot
  that is compromised, or simply confused, gets the same audience as a person.
  `"bots": "ignore"` turns them off.
- **The session's permission mode is the real limit.** The plugin does not sandbox
  anything: an event runs with whatever the session was launched with. Never run a
  PR-bound session with `--dangerously-skip-permissions`.

### What the plugin can do to your repository

It creates and deletes webhooks, so it needs admin. It never touches branch protection,
collaborators or settings, and it only deletes a webhook it has proved is its own — but
admin is admin, and the token it uses is your `gh` login.

### The webhook secret

Generated per `track`, held in memory, never written to a file, a log or a marker.
`gh webhook forward` takes it on its own argv, where any local user can read it with `ps`.
That cannot be avoided without replacing gh-webhook, and it means **this is not safe on a
machine you share with people you would not trust with that repository**.

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

Markers live under `${XDG_CACHE_HOME:-~/.cache}/claude-pr-channel/hooks/`, or under
`<cache.dir>/hooks/` when the config names one. They name the
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

One JSON file, at `${XDG_CONFIG_HOME:-~/.config}/claude-pr-channel/config.json`.
`PR_CHANNEL_CONFIG=/abs/path.json` points the plugin at a different file; that is a
location, not a setting, and it is the only environment variable the plugin itself reads.

For the settings people change most, with the JSON for each, see
[docs/configuration.md](docs/configuration.md). What follows is the full reference.

A missing file is fine: the plugin runs on the defaults below and `track` and `status`
say where it looked. A file that is present but invalid is never fallen back from — the
error names the key, what was wrong and what was expected, and `track` refuses until it
is fixed. A file `PR_CHANNEL_CONFIG` names must exist.

Precedence, per track: **a tool argument**, then **this file**, then **the built-in
default**. The `filters:` line in the `track` output says which of the three each value
came from. An argument is checked against the same definition as the file and refused the
same way — `invalid_argument`, naming the argument, what it got and what was expected.
MCP validates the request, never a tool's own input schema, so the layer that outranks
everything else is the one that most needs parsing before it is used.

Every key is optional and `{}` is a valid file; a defaulted object fills in its children.
These are the defaults in full:

```json
{
  "$schema": "./schema/config.schema.json",
  "version": 1,
  "events": {
    "comments": { "enabled": true },
    "reviews": { "enabled": true },
    "reviewComments": { "enabled": true },
    "checks": { "enabled": true, "wake": "completed" },
    "requiredChecks": { "enabled": true, "names": [] },
    "deployWorkflow": { "enabled": false, "workflowName": null },
    "lifecycle": {
      "opened": true, "synchronize": true, "ready_for_review": true,
      "converted_to_draft": true, "reopened": true, "closed": true, "merged": true,
      "labeled": false, "unlabeled": false, "assigned": false, "unassigned": false,
      "review_requested": false, "review_request_removed": false, "edited": false,
      "milestoned": false, "demilestoned": false, "locked": false, "unlocked": false,
      "auto_merge_enabled": false, "auto_merge_disabled": false,
      "enqueued": false, "dequeued": false
    }
  },
  "authors": { "mode": "operator", "allow": [], "bots": "handle" },
  "limits": {
    "maxPayloadBytes": 1048576,
    "rateLimit": { "maxDeliveries": 120, "windowMs": 60000 }
  },
  "cache": { "dir": null, "sweepOnTrack": true }
}
```

`authors.mode` is `operator` (the `gh` login alone), `listed` (exactly `authors.allow`) or
`anyone`. `events.checks.wake` is `failures`, `completed` or `all`. A deploy workflow is
matched on `workflow_run.name`, exactly and case-sensitively, and `enabled: true` requires
a name.

**Disabled means silent, not blind.** The switch is applied last, after normalization: a
disabled `synchronize` still advances the head, so later events are still marked stale; a
disabled `checks` still records check states, so all-required-green is still announced; a
disabled `closed`/`merged` still ends tracking, the session is simply not told. Suppressed
events are counted in the `suppressed` counter.

### The schema

`schema/config.schema.json` is a JSON Schema (draft 2020-12) generated from the same
definition that validates the file, so the two cannot drift. Point an editor at it with
`$schema`, or read it from `<CLAUDE_PLUGIN_ROOT>/schema/config.schema.json` — `status`
prints that path. Regenerate it with `bun run schema` after changing `src/config-schema.ts`;
`bun test` fails if the committed file is stale.

Adding an option that is not in the schema is a code change on purpose: an unknown key is
rejected with the list of keys that would have worked, rather than accepted and silently
delivering nothing. A pull_request action outside the catalogue, a new GitHub event or a
second deploy workflow all need a normalizer branch as well as a key.

### Environment variables this replaced

All nine are gone as values. One source, one file: a forgotten `export` that outranked a
file a UI had just written is exactly the surprise this avoids. Any of them still set at
startup makes `track` refuse, naming the key that took over.

| gone | now |
| --- | --- |
| `PR_CHANNEL_COMMENT_AUTHORS` | `authors.mode` / `authors.allow` |
| `PR_CHANNEL_BOT_COMMENTS` | `authors.bots` |
| `PR_CHANNEL_CI_EVENTS` | `events.checks.wake` |
| `PR_CHANNEL_REQUIRED_CHECKS` | `events.requiredChecks.names` |
| `PR_CHANNEL_MAX_PAYLOAD_BYTES` | `limits.maxPayloadBytes` |
| `PR_CHANNEL_RATE_LIMIT_MAX` / `_WINDOW_MS` | `limits.rateLimit.maxDeliveries` / `.windowMs` |
| `PR_CHANNEL_CACHE_DIR` | `cache.dir` |
| `PR_CHANNEL_SWEEP` | `cache.sweepOnTrack` |

What remains in the environment is never a setting: `PR_CHANNEL_CONFIG` (where the file
is), `XDG_CONFIG_HOME` / `XDG_CACHE_HOME` / `HOME` (platform conventions), and the
variables Claude Code sets for the plugin.

## Development

```
bun install
bun test
bun run schema   # after changing src/config-schema.ts
```

The suite is offline. `test/setup.ts` puts a `gh` shim first on `PATH` and the shim exits
99 unless a test configured it, so no test can reach GitHub.
