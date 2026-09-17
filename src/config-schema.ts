import { z } from 'zod';
import {
  CLAUDE_REPLY_PREFIX,
  CORE_LIFECYCLE_ACTIONS,
  PR_LIFECYCLE_ACTIONS,
  WORKFLOW_PLACEHOLDERS,
  unknownPlaceholders,
  type PrLifecycleAction,
} from './types.js';

// The zod tree is the single source of truth: validation and the JSON Schema a UI builds
// its form from are the same definition, so they cannot drift.
//
// Every object uses .prefault({}) rather than .default({}): on zod 4 a .default({}) is
// handed back verbatim and the object's own children keep no defaults at all, so half a
// config would silently come out empty.

const LIFECYCLE_DESCRIPTIONS: Readonly<Record<PrLifecycleAction, string>> = {
  opened: 'The pull request was opened.',
  synchronize: 'New commits were pushed, so the code under review changed.',
  ready_for_review: 'The pull request left draft.',
  converted_to_draft: 'The pull request went back to draft.',
  reopened: 'A closed pull request was reopened.',
  closed: 'The pull request was closed without merging. Tracking ends either way; this only decides whether the session is told.',
  merged: "GitHub's closed action with merged=true, split out so it can be enabled on its own. Tracking ends either way; this only decides whether the session is told.",
  labeled: 'A label was added. The label name is delivered as untrusted text.',
  unlabeled: 'A label was removed. The label name is delivered as untrusted text.',
  assigned: 'Someone was assigned.',
  unassigned: 'Someone was unassigned.',
  review_requested: 'A review was requested from a user or a team.',
  review_request_removed: 'A review request was withdrawn.',
  edited: 'The title, body or base branch was edited.',
  milestoned: 'The pull request was added to a milestone.',
  demilestoned: 'The pull request was removed from a milestone.',
  locked: 'The conversation was locked.',
  unlocked: 'The conversation was unlocked.',
  auto_merge_enabled: 'Auto-merge was enabled.',
  auto_merge_disabled: 'Auto-merge was disabled.',
  enqueued: 'The pull request entered a merge queue.',
  dequeued: 'The pull request left a merge queue.',
};

const CORE: readonly string[] = CORE_LIFECYCLE_ACTIONS;

const lifecycleShape = Object.fromEntries(
  PR_LIFECYCLE_ACTIONS.map((action) => [
    action,
    z.boolean().default(CORE.includes(action)).meta({ description: LIFECYCLE_DESCRIPTIONS[action] }),
  ]),
) as { [A in PrLifecycleAction]: z.ZodDefault<z.ZodBoolean> };

// Shared by the config file and by the per-track arguments that override it, so the two
// can never disagree about what a value is allowed to be.
export const CiEventsEnum = z.enum(['failures', 'completed', 'all']);
export const BotCommentsEnum = z.enum(['handle', 'listed', 'ignore']);
// "listed" needs the logins that go with it, and only the config file carries those. A
// track argument offering it could only ever mean "an empty list", which silently drops
// every bot, so the argument offers the two values it can actually satisfy.
export const TrackBotCommentsEnum = z.enum(['handle', 'ignore']);
export const WorkflowWakeEnum = z.enum(['success', 'failures', 'completed', 'all']);

const uniqueLogins = (values: string[]): string[] =>
  [...new Set(values.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0))];

const eventsSchema = z
  .strictObject({
    comments: z
      .strictObject({
        enabled: z
          .boolean()
          .default(true)
          .meta({ description: 'Deliver conversation comments on the pull request.' }),
      })
      .prefault({})
      .meta({ description: 'Conversation comments (GitHub issue_comment on the PR).' }),
    reviews: z
      .strictObject({
        enabled: z
          .boolean()
          .default(true)
          .meta({ description: 'Deliver submitted reviews that carry a body.' }),
      })
      .prefault({})
      .meta({ description: 'Pull request reviews. A review with no body is never delivered; its inline comments arrive on their own.' }),
    reviewComments: z
      .strictObject({
        enabled: z
          .boolean()
          .default(true)
          .meta({ description: 'Deliver inline review comments, which are answered in their own thread.' }),
      })
      .prefault({})
      .meta({ description: 'Inline review comments on a line of the diff.' }),
    checks: z
      .strictObject({
        enabled: z
          .boolean()
          .default(false)
          .meta({ description: 'Deliver every CI check on the pull request. There is no way to name individual checks, so this is all of them or none, which is why it is off: on a repository with twenty checks it is twenty interruptions per push. Prefer events.workflows, which names what to watch. Turn this on for CI that is not GitHub Actions — CircleCI, Buildkite, or an app posting its own check — since those emit no workflow to name.' }),
        wake: CiEventsEnum
          .default('completed')
          .meta({ description: 'Which CI transitions are worth a turn of the session: "failures" only the ones that finished badly, "completed" every finished check, "all" every transition including queued and in progress. It decides CI checks only; events.workflows is unaffected.' }),
      })
      .prefault({})
      .meta({ description: 'Every CI check, unnamed and ungrouped: check_run, check_suite and legacy commit statuses. Off by default.' }),
    workflows: z
      .array(
        z.strictObject({
          name: z
            .string()
            .trim()
            .min(1)
            .meta({ description: "The workflow's name, matched exactly and case-sensitively against workflow_run.name — the name: at the top of the workflow file, not the filename." }),
          wake: WorkflowWakeEnum.default('success').meta({
            description: 'Which of its runs are worth a turn of the session: "success" only a run that finished green, "failures" only one that finished badly, "completed" either, "all" every transition including queued and in progress.',
          }),
          instructions: z
            .string()
            .trim()
            .min(1)
            .max(1000)
            .optional()
            .meta({
              description:
                'Your own instructions for what to do when a run of this workflow wakes the session. They replace the wording the plugin would have written for it; the line naming the workflow and its state, and the rules every event carries, stay either way. One line is one instruction. May name {{workflow}}, {{state}}, {{conclusion}}, {{repo}}, {{pr}}, {{head}}, {{run_id}} and {{run_url}}; one with no value for this run renders as nothing, so phrase the line to read without it. Delivered as an instruction because you wrote it, unlike anything that came from GitHub.',
              'x-multiline': true,
            }),
        }),
      )
      .default([])
      .meta({ description: 'GitHub Actions workflows to watch by name, each with its own idea of what is worth waking for. An empty list watches none, which is the default: there is no workflow every repository has. Nothing here is deploy-specific — a workflow is matched by name alone, so this fits an image build, a docs publish or a nightly benchmark equally.' }),
    lifecycle: z
      .strictObject(lifecycleShape)
      .prefault({})
      .meta({ description: "Pull request lifecycle actions, keyed by GitHub's own action names. An action not listed here needs code, not configuration." }),
  })
  .prefault({})
  .meta({ description: 'Which kinds of event may wake the session. Disabled means silent, not blind: the event is still normalized and still updates the head and the check state, it just does not interrupt.' });

const authorsSchema = z
  .strictObject({
    mode: z
      .enum(['operator', 'listed', 'anyone'])
      .default('operator')
      .meta({ description: 'Whose comments and reviews may reach the session: "operator" only the login gh is authenticated as, "listed" exactly the logins in allow, "anyone" every human author. Acting on a comment means pushing code, so this is a trust boundary, not a preference.' }),
    allow: z
      .array(z.string())
      .overwrite(uniqueLogins)
      .default([])
      .meta({ description: 'GitHub logins, compared case-insensitively. Used when mode is "listed"; kept but unused under the other modes.' }),
    bots: BotCommentsEnum
      .default('handle')
      .meta({ description: 'Automated reviewers ([bot] accounts): "handle" treats every bot\'s findings like anyone else\'s, "listed" accepts only the bots in allowBots, "ignore" drops them all. mode never restricts bots.' }),
    allowBots: z
      .array(z.string())
      .overwrite(uniqueLogins)
      .default([])
      .meta({ description: 'Bot logins such as coderabbitai[bot], compared case-insensitively. GitHub appends the [bot] suffix itself, so write it. Used when bots is "listed"; kept but unused under the other values.' }),
  })
  .prefault({})
  .meta({ description: 'Who may drive this session through comments and reviews.' });

// The prefix is not decoration: a delivery whose body starts with it is the session's own
// reply arriving back through the webhook, and dropping it is what stops a session
// answering itself forever. Whatever is set here is both what the session is told to
// write and what the plugin looks for.
const repliesSchema = z
  .strictObject({
    prefix: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .default(CLAUDE_REPLY_PREFIX)
      .meta({ description: `How every comment the session posts begins, so a person reading the pull request can tell which comments are the agent's. It is also how the plugin recognises its own replies and declines to answer them. Markdown works: the default is ${CLAUDE_REPLY_PREFIX}. Pick something no human would open a comment with, and keep it short — it is prepended to every reply.` }),
  })
  .prefault({})
  .meta({ description: 'How the session signs the comments it posts.' });

const limitsSchema = z
  .strictObject({
    maxPayloadBytes: z
      .int()
      .min(1)
      .max(26_214_400)
      .default(1_048_576)
      .meta({ description: "Largest delivery body accepted, in bytes. GitHub's own webhook cap is 25 MiB." }),
    rateLimit: z
      .strictObject({
        maxDeliveries: z
          .int()
          .min(1)
          .default(120)
          .meta({ description: 'Signed deliveries accepted per window before the listener starts refusing.' }),
        windowMs: z
          .int()
          .min(1)
          .default(60_000)
          .meta({ description: 'Length of the rate-limit window, in milliseconds.' }),
      })
      .prefault({})
      .meta({ description: 'Rate limit applied to verified deliveries.' }),
  })
  .prefault({})
  .meta({ description: 'Limits the loopback listener enforces on incoming deliveries.' });

const cacheSchema = z
  .strictObject({
    dir: z
      .string()
      .nullable()
      .default(null)
      .meta({ description: 'Where webhook markers are kept. null means ${XDG_CACHE_HOME:-~/.cache}/claude-pr-channel; markers live under <dir>/hooks.' }),
    sweepOnTrack: z
      .boolean()
      .default(true)
      .meta({ description: 'Sweep markers left by dead sessions at the start of every track, deleting the webhooks they leaked.' }),
  })
  .prefault({})
  .meta({ description: 'The on-disk markers that make cleanup survive a killed session.' });

export const ConfigSchema = z
  .strictObject({
    $schema: z
      .string()
      .optional()
      .meta({ description: 'Optional path or URL to this JSON Schema, for editors. Ignored by the plugin.' }),
    version: z
      .literal(1)
      .default(1)
      .meta({ description: 'Config format version. 1 is the only accepted value; it is bumped only for an incompatible change of shape.' }),
    events: eventsSchema,
    authors: authorsSchema,
  replies: repliesSchema,
    limits: limitsSchema,
    cache: cacheSchema,
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    config.events.workflows.forEach((entry, index) => {
      if (seen.has(entry.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['events', 'workflows', index, 'name'],
          message: `duplicated: "${entry.name}" is already watched; expected each workflow named once`,
        });
      }
      seen.add(entry.name);
      const unknown = entry.instructions === undefined ? [] : unknownPlaceholders(entry.instructions);
      if (unknown.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['events', 'workflows', index, 'instructions'],
          message:
            `unknown placeholder ${unknown.map((name) => `"{{${name}}}"`).join(', ')}; ` +
            `expected one of ${WORKFLOW_PLACEHOLDERS.map((name) => `{{${name}}}`).join(', ')}`,
        });
      }
    });
    if (config.authors.mode === 'listed' && config.authors.allow.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['authors', 'allow'],
        message: 'required when authors.mode is "listed"; expected at least one GitHub login',
      });
    }
    if (config.authors.bots === 'listed' && config.authors.allowBots.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['authors', 'allowBots'],
        message: 'required when authors.bots is "listed"; expected at least one bot login',
      });
    }
  });

// Fields that also accept null, so an "expected a string" message does not read as a lie.
export const NULLABLE_PATHS: ReadonlySet<string> = new Set(['cache.dir']);

const SCHEMA_TITLE = 'claude-pr-channel configuration';

const SCHEMA_DESCRIPTION = [
  'Configuration for the claude-pr-channel Claude Code plugin, read from',
  '${XDG_CONFIG_HOME:-~/.config}/claude-pr-channel/config.json, or from the file named by',
  'PR_CHANNEL_CONFIG. Every key is optional and {} is a valid file. Precedence for the',
  'settings a track call can also carry: the tool argument, then this file, then the',
  'built-in default.',
].join(' ');

export function configJsonSchema(): Record<string, unknown> {
  const { $schema: dialect, ...rest } = z.toJSONSchema(ConfigSchema, { io: 'input', target: 'draft-2020-12' });
  return {
    $schema: dialect,
    // Relative until the repository has a public home to serve the file from.
    $id: 'config.schema.json',
    title: SCHEMA_TITLE,
    description: SCHEMA_DESCRIPTION,
    ...rest,
  };
}

// The arguments a single track call may carry. The same enums the file is validated
// against, so a value the file would refuse cannot slip in through the argument that
// outranks it. The MCP tool advertises this schema and the plugin validates against it:
// the low-level Server checks only the request envelope, never a tool's own inputSchema,
// so anything advertised here still has to be parsed before it is used.
export const TrackInputSchema = z.strictObject({
  pr: z
    .string()
    .optional()
    .meta({ description: 'PR number, "owner/name#n", or a github.com pull request URL. Omitted: the PR for the current branch.' }),
  repo: z
    .string()
    .optional()
    .meta({ description: 'owner/name; wins over the repo implied by pr or the current checkout.' }),
  ci_events: CiEventsEnum
    .optional()
    .meta({ description: 'Which CI transitions wake the session, for this PR only. Overrides events.checks.wake in the config file.' }),
  comment_authors: z
    .array(z.string())
    .optional()
    .meta({ description: 'Logins whose comments may reach the session, for this PR only. Overrides authors.mode/authors.allow; an empty array means anyone.' }),
  bot_comments: TrackBotCommentsEnum
    .optional()
    .meta({ description: 'Whether automated reviewers reach the session, for this PR only. Overrides authors.bots. To trust only named bots, set authors.bots to "listed" with authors.allowBots in the config file: the list has nowhere to live in a track call.' }),
  replace: z.boolean().optional().meta({ description: 'Stop the PR this session currently tracks first.' }),
});

export const TRACK_INPUT_KEYS: readonly string[] = Object.keys(TrackInputSchema.shape);

export function trackInputJsonSchema(): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(TrackInputSchema, { io: 'input', target: 'draft-2020-12' });
  return rest;
}
