# Configuring the channel

The README documents every setting. This is the short version: the things people
actually change, and the line of JSON that changes them.

## The file

```
~/.config/claude-pr-channel/config.json
```

It is optional — with no file at all, everything below runs on its defaults. Edit it
by hand, or open the editor:

```sh
bun run config
```

The editor builds its form from the same schema the plugin validates against, has a
Raw JSON tab, and saves through the plugin's own loader — so it cannot write a file
the plugin would then refuse.

### Editing from another device

The editor listens on loopback. To reach it from a phone or laptop on a VPN, name the
address to listen on:

```sh
PR_CHANNEL_UI_HOST=100.64.0.1 bun run config   # this machine's VPN address
```

`PR_CHANNEL_UI_PORT` moves the port (default 4319). `0.0.0.0` is refused: the editor
has no login, and on a machine with a public interface the wildcard would put it on
the internet. Give it one already-private address.

### Keeping it running

Started by hand, the editor dies with its shell — awkward when the device you edit from
cannot restart it. Run it under a service manager to survive reboots. Two things matter in
the unit: resolve the VPN address at start rather than hard-coding it, so a VPN outage
leaves the editor on loopback instead of somewhere unintended; and set `HOME`, without
which neither the editor nor the plugin can say where the configuration file lives.

## Recipes

**Let a teammate's comments drive the session.** By default only your own do — acting
on a comment means pushing code. Naming people replaces that default, so include
yourself.

```json
{ "authors": { "mode": "listed", "allow": ["your-login", "a-colleague"] } }
```

**Stop an automated reviewer talking to the session.** CodeRabbit and friends are
handled by default, because their findings are real review feedback.

```json
{ "authors": { "bots": "ignore" } }
```

**Track CI.** Name the workflows you care about. None are watched by default, and
nothing here is deploy-specific — a workflow is matched by name alone, so this fits a
lint run, an image build or a nightly benchmark equally. The name must match the
workflow's `name:` exactly, case included, and each entry decides for itself what is
worth waking for.

```json
{
  "events": {
    "workflows": [
      { "name": "Build Image", "wake": "success" },
      { "name": "Nightly Bench", "wake": "failures" }
    ]
  }
}
```

`wake` is `success` (the default — only a run that finished green, the right answer for
a build whose failure is not this PR's problem), `failures`, `completed` or `all`. An
empty list watches nothing, so there is no separate on/off switch to contradict it.

Use the workflow's name, not the job's. In a repository where `.github/workflows/lint.yml`
opens with `name: Lint` and its job is called `Check:Lint`, the entry is `Lint`. A
workflow whose jobs are a matrix is still one entry: the run finishes once however many
shards it fans out to, which is the point — naming shards means editing this file every
time the shard count changes.

**Track CI that is not GitHub Actions.** CircleCI, Buildkite and apps that post their own
result emit no workflow to name, so they are invisible to the list above. `checks` covers
them, at the cost of being all of them or none — there is no way to name one:

```json
{ "events": { "checks": { "enabled": true, "wake": "failures" } } }
```

It is off by default because on a repository with twenty checks it is twenty
interruptions per push, and because every GitHub Actions job also reports as a check —
so turning it on alongside a workflow list wakes the session twice for one failure.

**Track labels, or any other lifecycle action.** All 22 pull-request actions are
individually switchable. Seven are on by default: opened, synchronize,
ready_for_review, converted_to_draft, reopened, closed, merged.

```json
{ "events": { "lifecycle": { "labeled": true, "review_requested": true } } }
```

**Turn a whole category off.** Disabled means silent, not blind: the event is still
verified and deduplicated, it simply never interrupts.

```json
{ "events": { "reviewComments": { "enabled": false } } }
```

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

At the next `track`. A session already tracking keeps the settings it started with, so
after editing, restart that session or untrack and track again. Nothing is re-read
mid-flight.

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
  "authors": { "mode": "operator", "allow": [], "bots": "handle" },
  "limits": {
    "maxPayloadBytes": 1048576,
    "rateLimit": { "maxDeliveries": 120, "windowMs": 60000 }
  },
  "cache": { "dir": null, "sweepOnTrack": true }
}
```

`authors.mode` is `operator` (the `gh` login alone), `listed` (exactly `authors.allow`) or
`anyone`. `events.checks.wake` is `failures`, `completed` or `all`.

### The schema behind it

`schema/config.schema.json` is generated from the same definition that validates the file,
so the two cannot drift. Point an editor at it with `$schema`; `status` prints its path.
Regenerate with `bun run schema` after changing `src/config-schema.ts` — `bun test` fails
if the committed file is stale.
