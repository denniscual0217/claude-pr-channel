# claude-pr-channel

**Your Claude Code session watches its own pull request and acts on it.**

CI goes red — the session reads the failing job, fixes the cause, pushes, and the check
goes green. A reviewer leaves an inline comment — it answers in that thread. No more
babysitting the pull request; the plugin does it for you.

## Installing

You need [Bun](https://bun.sh) and the [GitHub CLI](https://cli.github.com), authenticated
as someone with **admin** on the repository — creating a webhook requires it. Add the
webhook extension:

```
gh extension install cli/gh-webhook
```

Then install the plugin. Once per machine:

```
claude plugin marketplace add /path/to/claude-pr-channel
claude plugin install pr-channel@pr-channel-local
```

## Starting a session

Launch from the PR's worktree, and ask for the plugin's channel:

```
claude --dangerously-load-development-channels plugin:pr-channel@pr-channel-local
```

The flag is needed because a plugin installed from a local directory is not on the
approved channels allowlist.

That is a lot to type per session. A shell function keeps it short and still takes the
usual flags, because the channel argument stays last:

```sh
# ~/.bashrc or ~/.zshrc
claude-pr() {
  claude "$@" --dangerously-load-development-channels plugin:pr-channel@pr-channel-local
}
```

Then `claude-pr` starts a session, and `claude-pr --resume <session-id>` resumes one. An
`alias` will not do: it can only append, and the channel argument has to come after your
own flags.

## Tracking a PR

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

## Resuming a session

A channel belongs to the process that opened it, so resuming needs the same flag as
starting. Pass it alongside `--resume`:

```
claude --resume <session-id> --dangerously-load-development-channels plugin:pr-channel@pr-channel-local
```

or `claude-pr --resume <session-id>` with the function above.

Resuming restores the conversation, not the tracking: the webhook was deleted when the
previous process exited. Run `/pr-channel:track` again to start receiving events. Drop the
channel flag and the session still resumes, but nothing will ever reach it.

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

No CI is delivered until you name the workflows you want. Comments, reviews and the main
lifecycle actions are on by default.

Put this at `${XDG_CONFIG_HOME:-~/.config}/claude-pr-channel/config.json`:

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

`name` is the workflow's own `name:`, not a job's. `wake` is `failures`, `success`,
`completed` or `all`. Every key is optional and `{}` is a valid file.

Or edit it in a browser:

```
bun run config
```

Changes take hold at the next `track` — `/pr-channel:untrack` then `/pr-channel:track`,
same session, no restart.

**[docs/configuration.md](docs/configuration.md)** has every setting: the other events you
can turn on, whose comments are acted on, and how to watch CI that is not GitHub Actions.

## Supported OS

Linux and macOS. Windows is not supported.

## Development

```
bun install
bun test
bun run typecheck
bun run schema   # after changing src/config-schema.ts
```

Run the typecheck as well as the tests: Bun executes TypeScript without checking it, so
`bun test` alone will not catch a type error. It is also what keeps the event kinds
honest — the switches in `src/channel/filter.ts` and `src/delivery/prompt.ts` have no
`default`, so adding a kind fails to compile until both decide what to do with it. The
tests stay green either way.

The suite is offline. `test/setup.ts` puts a `gh` shim first on `PATH` and the shim exits
99 unless a test configured it, so no test can reach GitHub.
