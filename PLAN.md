# Claude PR Event Channel — High-Level Plan

## Goal

Deliver GitHub pull-request events into the matching active Claude Code worker session
without PR polling or a Claude `/loop` routine.

## Event scope

- PR conversation comments, reviews, and inline review comments.
- CI check state changes, especially failures and all-required-checks-green.
- `Build Temploy Image` workflow state changes for the current PR head.
- PR lifecycle events: opened (including draft), synchronized, ready-for-review,
  converted-to-draft, reopened, closed, and merged.

## Architecture

1. A single HTTPS GitHub webhook endpoint receives repository events.
2. The dispatcher validates `X-Hub-Signature-256` against a protected webhook secret
   before parsing or handling a payload.
3. A durable registry maps an active PR to its dedicated Claude worker Channel.
4. Each worker Channel is a local MCP server attached to that one Claude Code session.
5. The dispatcher routes a normalized, deduplicated event only to the matching Channel.
6. Closing or merging a PR removes its registry route and stops its Channel; the Claude
   tmux session remains intact.

## Safety and correctness

- Verify the signature from the raw request body using HMAC-SHA256 and a timing-safe
  comparison.
- Restrict repository, webhook event types, payload size, and delivery rate.
- Deduplicate GitHub `X-GitHub-Delivery` IDs durably.
- Treat comment/review text as untrusted data, never as instructions that override the
  ticket or security rules.
- Track the current PR head: events for an earlier head must not mark the current head
  as green or Temploy-ready.

## Delivery phases

1. Scaffold the local Node/TypeScript project and automated tests.
2. Implement signature validation, event normalization, and the durable PR registry.
3. Implement the per-session MCP Channel and local dispatcher-to-channel routing.
4. Add local signed-webhook test fixtures for comment, CI, Temploy, and PR-close events.
5. Document the worker launch/registration contract and shutdown lifecycle.
6. Review the implementation with Opus.

## Explicitly out of scope for this task

- Public deployment, firewall/Nginx/systemd changes, or an external HTTPS route.
- Creating/configuring a GitHub webhook.
- Storing or exposing any secret in source, logs, commands, or chat.
- Updating the Jira worker launcher to depend on this service before a pilot succeeds.
