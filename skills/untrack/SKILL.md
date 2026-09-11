---
name: untrack
description: Stop delivering a GitHub pull request's events into this Claude Code session and delete the webhook this session created. Triggers on "stop watching this PR", "unsubscribe from the PR", "/pr-channel:untrack", or asking to stop tracking.
allowed-tools: Bash, Read
version: 3.0.0
---

# PR Channel — untrack

Stop tracking the pull request this session is bound to.

1. Call the **untrack** tool. It takes no arguments.

2. Report what came back: the PR that was being tracked, the webhook id that was deleted,
   and the delivery counters. If nothing was being tracked, say so and stop — calling it
   again is harmless.

3. On `hook_delete_failed`, the forwarder and listener are already stopped, so no further
   events arrive. The webhook itself could not be deleted: report the hook id, say that a
   background janitor is still retrying it, and that the next `track` in this session
   sweeps whatever is left. Only suggest `gh api -X DELETE repos/<owner>/<name>/hooks/<id>`
   if the user wants it gone right now.

Tracking also stops on its own when the PR is merged or closed, and when this session
ends — including a killed terminal or a killed tmux session. There is nothing to clean up
by hand in the normal case.
