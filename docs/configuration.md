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
cannot restart it. `packaging/pr-channel-config-ui.service` installs it as a systemd unit
that survives reboots and resolves the VPN address at each start, falling back to loopback
if the VPN is down. Install instructions are in the file.

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

**Only wake on CI failures.** The default delivers every finished check, which on a
repo with twenty checks is twenty interruptions per push.

```json
{ "events": { "checks": { "wake": "failures" } } }
```

**Announce when the required checks are all green.** GitHub never says which checks a
branch rule requires, so name them. Announced once per head; an empty list means
never.

```json
{ "events": { "requiredChecks": { "names": ["ci/lint", "ci/test"] } } }
```

**Watch a GitHub Actions workflow.** None are watched by default. Nothing here is
deploy-specific — a workflow is matched by name alone, so this fits an image build, a
docs publish or a nightly benchmark equally. The name must match the workflow's `name:`
exactly, case included, and each entry decides for itself what is worth waking for.

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

The old `PR_CHANNEL_*` environment variables are refused by name, each pointing at the
key that replaced it: two sources for one value is how a UI writes a file and nothing
changes because a forgotten export won. `PR_CHANNEL_CONFIG` survives, and
`PR_CHANNEL_UI_HOST` / `PR_CHANNEL_UI_PORT` configure the editor — all three name a
location, not a setting.
