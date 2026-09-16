import { normalizeRepo } from './repo.js';
import type {
  CheckConclusion,
  CheckState,
  CommentAction,
  PrEvent,
  PrEventKind,
  PrLifecycleAction,
  PrLifecycleEvent,
  PrRef,
  ReviewAction,
  ReviewState,
  UntrustedGithubText,
  WorkflowRunState,
} from '../types.js';
import {
  CHECK_CONCLUSIONS,
  PR_LIFECYCLE_ACTIONS,
  REVIEW_STATES,
  isClaudeAuthored,
  untrusted,
} from '../types.js';

export interface UnresolvedHead {
  readonly kind: PrEventKind;
  readonly headSha: string;
}

export type BotComments = 'handle' | 'listed' | 'ignore';

export interface NormalizeOptions {
  // check_run / check_suite / workflow_run / status payloads name no PR when the run was
  // not triggered by a pull_request event and for every fork PR, so the head SHA is all
  // there is to go on; the registry resolves it against the heads its routes have held.
  readonly resolvePrsByHead?: (repo: string, headSha: string) => readonly PrRef[];
  // Called when such a delivery belongs to no known route, so the caller can account for
  // it instead of letting it vanish.
  readonly onUnresolvedHead?: (unresolved: UnresolvedHead) => void;
  readonly now?: () => string;
  // Whose comments and reviews may reach the session. null allows every human author.
  // Acting on a comment means pushing code, so this is a trust boundary.
  readonly commentAuthors?: ReadonlySet<string> | null;
  // Automated reviewers are handled by default; 'ignore' drops them, 'listed' narrows
  // them to botAuthors. mode/commentAuthors never applies to a bot.
  readonly botComments?: BotComments;
  // Which bot logins may reach the session. null accepts every bot botComments allows.
  readonly botAuthors?: ReadonlySet<string> | null;
  // Workflow names to watch, matched exactly and case-sensitively. Nothing is matched
  // until one is configured: there is no workflow every repository has.
  readonly workflowNames?: ReadonlySet<string> | null;
}

export function normalizeWebhook(eventName: string, payload: unknown, options: NormalizeOptions = {}): PrEvent | null {
  return normalizeWebhookAll(eventName, payload, options)[0] ?? null;
}

// One delivery can concern several PRs (a check run for a SHA that heads two PRs).
export function normalizeWebhookAll(
  eventName: string,
  payload: unknown,
  options: NormalizeOptions = {},
): readonly PrEvent[] {
  const body = obj(payload);
  if (!body) return [];
  const repo = repoOf(body);
  if (!repo) return [];
  const ctx: Ctx = { body, repo, actor: loginOf(body['sender']), now: options.now ?? isoNow, options };

  switch (eventName) {
    case 'issue_comment':
      return listOf(normalizeIssueComment(ctx));
    case 'pull_request_review':
      return listOf(normalizeReview(ctx));
    case 'pull_request_review_comment':
      return listOf(normalizeReviewComment(ctx));
    case 'pull_request':
      return listOf(normalizeLifecycle(ctx));
    case 'check_run':
      return normalizeCheckRun(ctx);
    case 'check_suite':
      return normalizeCheckSuite(ctx);
    case 'workflow_run':
      return normalizeWorkflowRun(ctx);
    case 'status':
      return normalizeStatus(ctx);
    default:
      return [];
  }
}

interface Ctx {
  readonly body: Json;
  readonly repo: string;
  readonly actor: string | null;
  readonly now: () => string;
  readonly options: NormalizeOptions;
}

function isBotUser(raw: unknown): boolean {
  const user = obj(raw);
  if (!user) return false;
  if (str(user['type']) === 'Bot') return true;
  return (str(user['login']) ?? '').endsWith('[bot]');
}

// An automated reviewer is feedback on this PR and is handled like any other unless the
// operator has narrowed it. A person who is not on the allowlist is not: answering a
// colleague is the author's job, not this session's. Bots that only narrate get no reply
// anyway, because an event carrying nothing to act on is answered with silence.
function senderAllowed(ctx: Ctx, raw: unknown): boolean {
  if (isBotUser(raw)) return botAllowed(ctx, raw);
  const allowed = ctx.options.commentAuthors;
  if (allowed === undefined || allowed === null) return true;
  const login = str(obj(raw)?.['login'] ?? null);
  return login !== null && allowed.has(login.toLowerCase());
}

function botAllowed(ctx: Ctx, raw: unknown): boolean {
  if (ctx.options.botComments === 'ignore') return false;
  const listed = ctx.options.botAuthors;
  if (listed === undefined || listed === null) return true;
  const login = str(obj(raw)?.['login'] ?? null);
  return login !== null && listed.has(login.toLowerCase());
}

// The person who edits or deletes a comment is not its author: GitHub lets anyone with
// write access rewrite anyone else's text, which would otherwise arrive here under the
// author's name. On created/submitted the two are the same account, so this only bites
// when someone else touched the comment.
//
// A bot sender is held to a stricter rule than a bot author. Any workflow on the
// repository can PATCH another user's comment as github-actions[bot], so letting the
// handled-bot branch satisfy the sender leg would hand the whole gate to anyone who can
// push a workflow. A bot may therefore edit only its own comment; editing a human's is
// someone speaking as that human, and has to clear the human allowlist.
function partiesAllowed(ctx: Ctx, author: unknown): boolean {
  if (!senderAllowed(ctx, author)) return false;
  const sender = ctx.body['sender'];
  if (isBotUser(sender) && !isBotUser(author)) return humanAllowed(ctx, sender);
  if (isBotUser(sender) && loginOf(sender) !== loginOf(author)) return false;
  return senderAllowed(ctx, sender);
}

// The author allowlist alone, with no bot short-circuit.
function humanAllowed(ctx: Ctx, raw: unknown): boolean {
  const allowed = ctx.options.commentAuthors;
  if (allowed === undefined || allowed === null) return true;
  const login = str(obj(raw)?.['login'] ?? null);
  return login !== null && allowed.has(login.toLowerCase());
}

function normalizeIssueComment(ctx: Ctx): PrEvent | null {
  const issue = obj(ctx.body['issue']);
  const comment = obj(ctx.body['comment']);
  const action = commentAction(str(ctx.body['action']));
  if (!issue || !comment || !action || !obj(issue['pull_request'])) return null;
  const prNumber = num(issue['number']);
  const commentId = num(comment['id']);
  if (prNumber === null || commentId === null) return null;
  // The worker's own reply arrives back through the webhook; delivering it would have
  // the session answer itself.
  if (isClaudeAuthored(str(comment['body']) ?? '')) return null;
  if (!partiesAllowed(ctx, comment['user'])) return null;
  return {
    kind: 'pr_comment',
    prRef: { repo: ctx.repo, prNumber },
    headSha: null,
    actorLogin: loginOf(comment['user']) ?? ctx.actor,
    occurredAtIso: iso(comment['updated_at'], comment['created_at']) ?? ctx.now(),
    htmlUrl: str(comment['html_url']),
    action,
    commentId,
    untrustedBody: untrusted(str(comment['body']) ?? ''),
  };
}

function normalizeReview(ctx: Ctx): PrEvent | null {
  const pr = obj(ctx.body['pull_request']);
  const review = obj(ctx.body['review']);
  const action = reviewAction(str(ctx.body['action']));
  if (!pr || !review || !action) return null;
  const prNumber = num(pr['number']);
  const reviewId = num(review['id']);
  if (prNumber === null || reviewId === null) return null;
  if (isClaudeAuthored(str(review['body']) ?? '')) return null;
  if (!partiesAllowed(ctx, review['user'])) return null;
  // A review submitted with no body is just the envelope around its inline comments,
  // which arrive as their own events. Delivering it too asks the session to respond to
  // a review that says nothing.
  if ((str(review['body']) ?? '').trim().length === 0) return null;
  return {
    kind: 'pr_review',
    prRef: { repo: ctx.repo, prNumber },
    headSha: headShaOf(pr) ?? str(review['commit_id']),
    actorLogin: loginOf(review['user']) ?? ctx.actor,
    occurredAtIso: iso(review['submitted_at'], pr['updated_at']) ?? ctx.now(),
    htmlUrl: str(review['html_url']),
    action,
    reviewId,
    reviewState: action === 'dismissed' ? 'dismissed' : reviewState(str(review['state'])),
    untrustedBody: untrusted(str(review['body']) ?? ''),
  };
}

function normalizeReviewComment(ctx: Ctx): PrEvent | null {
  const pr = obj(ctx.body['pull_request']);
  const comment = obj(ctx.body['comment']);
  const action = commentAction(str(ctx.body['action']));
  if (!pr || !comment || !action) return null;
  const prNumber = num(pr['number']);
  const commentId = num(comment['id']);
  if (prNumber === null || commentId === null) return null;
  if (isClaudeAuthored(str(comment['body']) ?? '')) return null;
  if (!partiesAllowed(ctx, comment['user'])) return null;
  return {
    kind: 'pr_review_comment',
    prRef: { repo: ctx.repo, prNumber },
    headSha: headShaOf(pr) ?? str(comment['commit_id']),
    actorLogin: loginOf(comment['user']) ?? ctx.actor,
    occurredAtIso: iso(comment['updated_at'], comment['created_at']) ?? ctx.now(),
    htmlUrl: str(comment['html_url']),
    action,
    commentId,
    reviewId: num(comment['pull_request_review_id']),
    inReplyToId: num(comment['in_reply_to_id']),
    path: str(comment['path']) ?? '',
    line: num(comment['line']) ?? num(comment['original_line']),
    untrustedBody: untrusted(str(comment['body']) ?? ''),
  };
}

function normalizeLifecycle(ctx: Ctx): PrLifecycleEvent | null {
  const pr = obj(ctx.body['pull_request']);
  const rawAction = str(ctx.body['action']);
  if (!pr || !rawAction) return null;
  const prNumber = num(pr['number']);
  if (prNumber === null) return null;
  const action = lifecycleAction(rawAction, pr);
  if (!action) return null;
  return {
    kind: 'pr_lifecycle',
    prRef: { repo: ctx.repo, prNumber },
    headSha: headShaOf(pr),
    actorLogin: ctx.actor,
    occurredAtIso: iso(pr['updated_at']) ?? ctx.now(),
    htmlUrl: str(pr['html_url']),
    action,
    draft: pr['draft'] === true,
    baseRef: str(obj(pr['base'])?.['ref']) ?? '',
    headRef: str(obj(pr['head'])?.['ref']) ?? '',
    untrustedTitle: untrusted(str(pr['title']) ?? ''),
    untrustedSubject: subjectOf(ctx.body, action),
  };
}

// A label name, an assignee, a requested reviewer or team, a milestone title: what the
// action was about. Label names and milestone titles are free text written on GitHub, so
// the whole subject is fenced rather than interpolated into the prompt.
function subjectOf(body: Json, action: PrLifecycleAction): UntrustedGithubText | null {
  const named =
    str(obj(body['label'])?.['name']) ??
    str(obj(body['assignee'])?.['login']) ??
    str(obj(body['requested_reviewer'])?.['login']) ??
    str(obj(body['requested_team'])?.['name']) ??
    str(obj(body['milestone'])?.['title']);
  switch (action) {
    case 'labeled':
    case 'unlabeled':
    case 'assigned':
    case 'unassigned':
    case 'review_requested':
    case 'review_request_removed':
    case 'milestoned':
    case 'demilestoned':
      return named === null ? null : untrusted(named);
    default:
      return null;
  }
}

const KNOWN_LIFECYCLE_ACTIONS: ReadonlySet<string> = new Set(PR_LIFECYCLE_ACTIONS);

// 'merged' is this plugin's split of GitHub's single closed action, so that a merge and
// an abandonment can be told apart without reading the payload again downstream.
function lifecycleAction(raw: string, pr: Json): PrLifecycleAction | null {
  if (raw === 'merged') return null;
  if (raw === 'closed') return pr['merged'] === true || str(pr['merged_at']) !== null ? 'merged' : 'closed';
  return KNOWN_LIFECYCLE_ACTIONS.has(raw) ? (raw as PrLifecycleAction) : null;
}

function normalizeCheckRun(ctx: Ctx): readonly PrEvent[] {
  const run = obj(ctx.body['check_run']);
  const action = str(ctx.body['action']);
  if (!run || action === 'requested_action') return [];
  const headSha = str(run['head_sha']);
  const checkName = str(run['name']);
  if (!headSha || !checkName) return [];
  const state =
    action === 'rerequested' ? { status: 'queued' as const } : checkState(str(run['status']), str(run['conclusion']));
  if (!state) return [];
  const base = {
    headSha,
    actorLogin: ctx.actor,
    occurredAtIso: iso(run['completed_at'], run['started_at']) ?? ctx.now(),
    htmlUrl: url(run['html_url']),
    checkName,
    checkRunId: num(run['id']),
    state,
    detailsUrl: url(run['details_url']) ?? url(run['html_url']),
  };
  return prRefsForSha(ctx, run['pull_requests'], headSha, 'ci_check').map((prRef) => ({
    kind: 'ci_check',
    prRef,
    ...base,
  }));
}

// A check suite is one app's bundle of runs (one per GitHub Actions workflow run); it
// carries no run names, so it is reported as a synthetic, clearly-prefixed check. Only
// completion is interesting: requested/rerequested suites say nothing about state.
function normalizeCheckSuite(ctx: Ctx): readonly PrEvent[] {
  const suite = obj(ctx.body['check_suite']);
  if (!suite || str(ctx.body['action']) !== 'completed') return [];
  const headSha = str(suite['head_sha']);
  if (!headSha) return [];
  const state = checkState(str(suite['status']), str(suite['conclusion']));
  if (!state || state.status !== 'completed') return [];
  const app = obj(suite['app']);
  const appName = str(app?.['slug']) ?? str(app?.['name']) ?? 'unknown-app';
  const base = {
    headSha,
    actorLogin: ctx.actor,
    occurredAtIso: iso(suite['updated_at'], suite['created_at']) ?? ctx.now(),
    htmlUrl: null,
    checkName: `check_suite:${appName}`,
    checkRunId: null,
    state,
    detailsUrl: null,
  };
  return prRefsForSha(ctx, suite['pull_requests'], headSha, 'ci_check').map((prRef) => ({
    kind: 'ci_check',
    prRef,
    ...base,
  }));
}

// Workflows named in the config, matched exactly and case-sensitively. Every other
// workflow run on the repository — including all of them when none is configured —
// produces no event at all. Nothing here knows what a workflow does: the name is the
// whole of the match, so a deploy, a docs publish and a benchmark are the same to it.
function normalizeWorkflowRun(ctx: Ctx): readonly PrEvent[] {
  const configured = ctx.options.workflowNames ?? null;
  if (configured === null || configured.size === 0) return [];
  const run = obj(ctx.body['workflow_run']);
  if (!run) return [];
  const name = str(run['name']) ?? str(obj(ctx.body['workflow'])?.['name']);
  if (name === null || !configured.has(name)) return [];
  const headSha = str(run['head_sha']);
  const workflowRunId = num(run['id']);
  if (!headSha || workflowRunId === null) return [];
  const state = workflowRunState(str(run['status']) ?? str(ctx.body['action']), str(run['conclusion']));
  if (!state) return [];
  const base = {
    headSha,
    actorLogin: loginOf(run['triggering_actor']) ?? loginOf(run['actor']) ?? ctx.actor,
    occurredAtIso: iso(run['updated_at'], run['run_started_at'], run['created_at']) ?? ctx.now(),
    htmlUrl: url(run['html_url']),
    workflowName: name,
    workflowRunId,
    runAttempt: num(run['run_attempt']) ?? 1,
    state,
  };
  return prRefsForSha(ctx, run['pull_requests'], headSha, 'workflow').map((prRef) => ({
    kind: 'workflow',
    prRef,
    ...base,
  }));
}

// Legacy commit statuses name no PR at all, so they only normalize when the registry
// can resolve the SHA. Not in ALLOWED_GITHUB_EVENTS today; harmless if it never arrives.
function normalizeStatus(ctx: Ctx): readonly PrEvent[] {
  const headSha = str(ctx.body['sha']);
  const context = str(ctx.body['context']);
  if (!headSha || !context) return [];
  const state = statusState(str(ctx.body['state']));
  if (!state) return [];
  const base = {
    headSha,
    actorLogin: ctx.actor,
    occurredAtIso: iso(ctx.body['updated_at'], ctx.body['created_at']) ?? ctx.now(),
    htmlUrl: url(ctx.body['target_url']),
    checkName: context,
    checkRunId: null,
    state,
    detailsUrl: url(ctx.body['target_url']),
  };
  return prRefsForSha(ctx, undefined, headSha, 'ci_check').map((prRef) => ({ kind: 'ci_check', prRef, ...base }));
}

function prRefsForSha(ctx: Ctx, pullRequests: unknown, headSha: string, kind: PrEventKind): readonly PrRef[] {
  const listed: PrRef[] = [];
  if (Array.isArray(pullRequests)) {
    for (const entry of pullRequests) {
      const prNumber = num(obj(entry)?.['number']);
      if (prNumber !== null && !listed.some((ref) => ref.prNumber === prNumber)) {
        listed.push({ repo: ctx.repo, prNumber });
      }
    }
  }
  if (listed.length > 0) return listed;
  const resolved = ctx.options.resolvePrsByHead?.(ctx.repo, headSha) ?? [];
  if (resolved.length === 0) ctx.options.onUnresolvedHead?.({ kind, headSha });
  return resolved;
}

function checkState(status: string | null, conclusion: string | null): CheckState | null {
  switch (status) {
    case 'queued':
    case 'waiting':
    case 'pending':
    case 'requested':
      return { status: 'queued' };
    case 'in_progress':
      return { status: 'in_progress' };
    case 'completed':
      return conclusion === null ? { status: 'in_progress' } : { status: 'completed', conclusion: toConclusion(conclusion) };
    default:
      return null;
  }
}

function workflowRunState(status: string | null, conclusion: string | null): WorkflowRunState | null {
  return status === 'requested' ? { status: 'requested' } : checkState(status, conclusion);
}

function statusState(state: string | null): CheckState | null {
  switch (state) {
    case 'pending':
      return { status: 'in_progress' };
    case 'success':
      return { status: 'completed', conclusion: 'success' };
    case 'failure':
    case 'error':
      return { status: 'completed', conclusion: 'failure' };
    default:
      return null;
  }
}

// A conclusion this code does not know is terminal and not a success; surfacing it as
// a failure errs toward the session looking at it.
function toConclusion(raw: string): CheckConclusion {
  return (CHECK_CONCLUSIONS as readonly string[]).includes(raw) ? (raw as CheckConclusion) : 'failure';
}

// A deletion is a retraction, so the body must not arrive as a fresh instruction — the
// prompt would tell the session to act on text its author has just withdrawn, and a
// post-then-delete would deliver the same instruction twice.
function commentAction(raw: string | null): CommentAction | null {
  return raw === 'created' || raw === 'edited' ? raw : null;
}

function reviewAction(raw: string | null): ReviewAction | null {
  return raw === 'submitted' || raw === 'edited' || raw === 'dismissed' ? raw : null;
}

function reviewState(raw: string | null): ReviewState {
  const lowered = raw?.toLowerCase() ?? '';
  return (REVIEW_STATES as readonly string[]).includes(lowered) ? (lowered as ReviewState) : 'commented';
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// A CI app chooses these and the session is told to paste one into a public comment
// verbatim, so anything that is not a plain fetchable link is dropped rather than
// rendered. Plain http stays valid: a self-hosted Jenkins is exactly this feature's case.
// The danger in a CI-supplied URL is a scheme that executes, or a line break that lets it
// pose as another line of the prompt. A space is neither: self-hosted Jenkins puts job
// names in the path routinely, and dropping the link there costs the session the one
// reference the reply should carry. Spaces are encoded, newlines and controls refused.
function url(value: unknown): string | null {
  const raw = str(value);
  if (raw === null || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return raw.replace(/ /g, '%20');
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function iso(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    const raw = str(candidate);
    if (raw === null) continue;
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return null;
}

function isoNow(): string {
  return new Date().toISOString();
}

function loginOf(user: unknown): string | null {
  return str(obj(user)?.['login']);
}

function repoOf(body: Json): string | null {
  const fullName = str(obj(body['repository'])?.['full_name']);
  if (!fullName) return null;
  const repo = normalizeRepo(fullName);
  return /^[^/\s]+\/[^/\s]+$/.test(repo) ? repo : null;
}

function headShaOf(pr: Json): string | null {
  return str(obj(pr['head'])?.['sha']);
}

function listOf<T>(value: T | null): readonly T[] {
  return value === null ? [] : [value];
}
