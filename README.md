# claude-pr-channel

**Your Claude Code session watches its own pull request and acts on it.**

CI goes red — the session reads the failing job, fixes the cause, pushes, and the check
goes green. A reviewer leaves an inline comment — it answers in that thread, or changes
the code and says what it changed. You do not relay any of it, and you do not sit watching
the terminal for something to happen.

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

`track` accepts `pr`, `repo`, `ci_events`, `comment_authors`,
`bot_comments` and `replace`. The four filters override the matching keys in the
[config file](#configuration) for that one PR.

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

## Configuration

One JSON file, at `${XDG_CONFIG_HOME:-~/.config}/claude-pr-channel/config.json`.
Every key is optional, `{}` is valid, and a missing file just means the defaults.

By default the plugin delivers comments, reviews and the main lifecycle actions, and no
CI at all — name the workflows you want under `events.workflows`.

It is plain JSON and meant to be edited by hand. There is also a local editor:

```
bun run config
```

An invalid file is never fallen back from: `track` refuses until it is fixed, naming the
key, what was wrong and what was expected. Changes apply when a channel next starts; a
session already tracking keeps the settings it began with.

**[docs/configuration.md](docs/configuration.md) is the manual** — every setting, what
each one delivers, and the JSON for the things people actually change.

## Development

```
bun install
bun test
bun run schema   # after changing src/config-schema.ts
```

The suite is offline. `test/setup.ts` puts a `gh` shim first on `PATH` and the shim exits
99 unless a test configured it, so no test can reach GitHub.
