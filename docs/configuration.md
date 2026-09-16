# Configuring the channel

Every setting, what each one does, and the JSON for the things people actually change.

## The file

```
~/.config/claude-pr-channel/config.json
```

It is optional — with no file at all, everything below runs on its defaults. Edit it
by hand, or open the editor:

```sh
bun run config
```

It prints a link with a token in the fragment — `http://127.0.0.1:4319/#<token>` — and
that token is what lets the page read and write the file; a bare URL loads but every API
call answers 401. The token is generated once into
`~/.config/claude-pr-channel/ui-token` at mode 0600 and reused on every restart, so a
bookmark keeps working.

The editor builds its form from the same schema the plugin validates against, has a
Raw JSON tab, and saves through the plugin's own loader — so it cannot write a file the
plugin would then refuse. Writes go through a temporary file and a rename, so an
interrupted save leaves the previous config intact.

### Editing from another device

The editor listens on loopback. To reach it from a phone or laptop on a VPN, name the
address to listen on:

```sh
PR_CHANNEL_UI_HOST=100.64.0.1 bun run config   # this machine's VPN address
```

`PR_CHANNEL_UI_PORT` moves the port (default 4319). `0.0.0.0` is refused: on a machine
with a public interface the wildcard would put the editor on the internet. Give it one
already-private address — the address decides who can reach the editor, the token decides
who may edit. Bookmark the whole printed link on the phone, `#<token>` included; without
the fragment the page loads and nothing else works.

### Keeping it running

Started by hand, the editor dies with its shell — awkward when the device you edit from
cannot restart it. Run it under a service manager to survive reboots. Two things matter in
the unit: resolve the VPN address at start rather than hard-coding it, so a VPN outage
leaves the editor on loopback instead of somewhere unintended; and set `HOME`, without
which neither the editor nor the plugin can say where the configuration file lives.

## Recipes

**Let a teammate's comments drive the session.** By default only your own do — acting on a
comment means pushing code. Naming people replaces that default, so include yourself.

```json
{ "authors": { "mode": "listed", "allow": ["your-login", "a-colleague"] } }
```

An edit or a dismissal reaches the session only when both the author and the person who
made it are allowed — anyone with write access can rewrite someone else's comment, and
any workflow on the repository can do it as `github-actions[bot]`, so a bot clears that
second check only for its own comment. A deletion is not delivered at all: its text has
just been withdrawn, and delivering it would ask the session to act on a retraction.

**Stop an automated reviewer talking to the session.** CodeRabbit and friends are handled
by default, because their findings are real review feedback.

```json
{ "authors": { "bots": "ignore" } }
```

**Let only one automated reviewer talk to the session.** `authors.mode` never restricts
bots, so naming the ones you trust is the only way to refuse the rest. GitHub appends the
`[bot]` suffix itself, so the login carries it.

```json
{ "authors": { "bots": "listed", "allowBots": ["coderabbitai[bot]"] } }
```

**Track CI.** Name the workflows you care about — see [Workflows](#workflows).

```json
{ "events": { "workflows": [{ "name": "Typecheck", "wake": "failures" }] } }
```

**Hear about labels.** Or any of the other lifecycle actions that are off by default.

```json
{ "events": { "lifecycle": { "labeled": true, "review_requested": true } } }
```

**Turn a whole category off.** Disabled means silent, not blind: the event is still
verified and deduplicated, it simply never interrupts.

```json
{ "events": { "reviewComments": { "enabled": false } } }
```

## Every event

What the plugin can deliver, and what decides it.

| event | delivered by default | key |
| --- | --- | --- |
| Conversation comment | yes | `events.comments.enabled` |
| Review with a body | yes | `events.reviews.enabled` |
| Inline review comment | yes | `events.reviewComments.enabled` |
| A named workflow's run | no — none are named | `events.workflows` |
| Every CI check, unnamed | no | `events.checks.enabled` |
| Pull request lifecycle | seven of 22 actions | `events.lifecycle.<action>` |

Comments and reviews are also filtered by who wrote them — see `authors` below.

### Workflows

`events.workflows` names GitHub Actions workflows to watch. Nothing about it is
deploy-specific: a workflow is matched by name alone, so the same key fits a lint run, an
image build or a nightly benchmark.

```json
{
  "events": {
    "workflows": [
      { "name": "Typecheck", "wake": "failures" },
      { "name": "Unit Tests", "wake": "failures" },
      { "name": "Build Image", "wake": "success" }
    ]
  }
}
```

`name` is the **workflow's** `name:`, the line at the top of the `.yml` — not the job's.
In a repository where `.github/workflows/lint.yml` opens with `name: Lint` and its job is
called `Check:Lint`, the entry is `Lint`. Matching is exact and case-sensitive.

A workflow whose jobs are a matrix is still one entry: the run finishes once however many
shards it fans out to. That is the point — naming shards means editing this file every
time the shard count changes.

`wake` decides which of its runs are worth a turn:

| `wake` | wakes on |
| --- | --- |
| `success` (default) | only a run that finished green — the answer for a build whose failure is not this PR's problem |
| `failures` | only a run that finished badly |
| `completed` | either |
| `all` | every transition, including queued and in progress |

An empty list watches nothing, so there is no separate on/off switch to contradict it.

### Lifecycle actions

All 22 of GitHub's pull-request actions are individually switchable under
`events.lifecycle`. Seven are on:

`opened`, `synchronize` (new commits pushed), `ready_for_review`, `converted_to_draft`,
`reopened`, `closed`, `merged`.

Fifteen are off:

`labeled`, `unlabeled`, `assigned`, `unassigned`, `review_requested`,
`review_request_removed`, `edited`, `milestoned`, `demilestoned`, `locked`, `unlocked`,
`auto_merge_enabled`, `auto_merge_disabled`, `enqueued`, `dequeued`.

```json
{ "events": { "lifecycle": { "labeled": true, "review_requested": true } } }
```

`closed` and `merged` end tracking whether or not they are delivered; the switch only
decides whether the session is told. The label, assignee, reviewer or milestone an action
names is delivered as untrusted text.

### CI that is not GitHub Actions

CircleCI, Buildkite and apps that post their own result emit no workflow to name, so
`events.workflows` cannot see them. `events.checks` covers every check on the PR, at the
cost of being all of them or none — there is no way to name one:

```json
{ "events": { "checks": { "enabled": true, "wake": "failures" } } }
```

A check name is delivered as untrusted text, and a details link that is not a plain
`http(s)` URL is dropped rather than handed to the session: on a repository that accepts
outside pull requests, the job name in the workflow file at the PR head is written by
whoever opened it.

It is off by default because on a repository with twenty checks it is twenty
interruptions per push, and because every GitHub Actions job also reports as a check — so
turning it on alongside a workflow list wakes the session twice for one failure.

## What beats what

Three layers, most specific first:

| Layer             | Scope                                                            |
| ----------------- | ---------------------------------------------------------------- |
| tool argument     | One PR — ask when you track: *"track 3053, only wake me on failures"* |
| config file       | Every session on this machine                                     |
| built-in default  | What you get with no file                                         |

The `filters:` line in the `track` output names which layer each value came from, so
you never have to guess whether an edit took effect.

## When changes apply

At the next `track` — not at the next session. `/pr-channel:untrack` then
`/pr-channel:track` in the same session is enough, and there is no need to exit or resume.
A session already tracking keeps the settings it started with; nothing is re-read
mid-flight. Only a change to the plugin's own code needs a new session, because the server
loads it once at startup.

## When it refuses

An invalid file is never silently ignored and never half-applied. Every problem is
reported at once, naming the key, what was wrong, and what was expected:

```
events.lifecycle: unknown key "labled"; known keys: opened, synchronize, …
limits.maxPayloadBytes: 0 is too small; expected an integer >= 1
```

A tool argument is checked against the same definition and refused the same way.

## The one setting to think twice about

`"authors": { "mode": "anyone" }` lets every human commenter drive a session that can
edit files, run commands and push. Comment text is fenced and labelled untrusted, and
the session is told to weigh it rather than obey it — but that is a mitigation, not a
boundary. On a public repository it means strangers.

## Settings are file-only

Nothing here can be set from the environment; the old `PR_CHANNEL_*` variables are refused
by name, each naming the key that replaced it. Two sources for one value is how a UI writes
a file and nothing changes because a forgotten export won. The three that remain —
`PR_CHANNEL_CONFIG`, `PR_CHANNEL_UI_HOST`, `PR_CHANNEL_UI_PORT` — name a location, not a
setting.

## Every setting

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
    "checks": { "enabled": false, "wake": "completed" },
    "workflows": [],
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
  "authors": { "mode": "operator", "allow": [], "bots": "handle", "allowBots": [] },
  "limits": {
    "maxPayloadBytes": 1048576,
    "rateLimit": { "maxDeliveries": 120, "windowMs": 60000 }
  },
  "cache": { "dir": null, "sweepOnTrack": true }
}
```

`authors.mode` is `operator` (the `gh` login alone), `listed` (exactly `authors.allow`) or
`anyone`, and it decides nothing about bots. `authors.bots` is `handle` (every bot),
`listed` (exactly `authors.allowBots`) or `ignore` (none). `events.checks.wake` is
`failures`, `completed` or `all`.

### The schema behind it

`schema/config.schema.json` is generated from the same definition that validates the file,
so the two cannot drift. Point an editor at it with `$schema`; `status` prints its path.
Regenerate with `bun run schema` after changing `src/config-schema.ts` — `bun test` fails
if the committed file is stale.
