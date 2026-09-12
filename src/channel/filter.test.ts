import { describe, expect, it } from 'bun:test';
import { DEFAULT_CONFIG, resolveTracking } from '../config.js';
import { newEventId } from '../events/ids.js';
import type { EnvelopeOf, PrEventKind, PrLifecycleAction, PrRef } from '../types.js';
import { untrusted } from '../types.js';
import type { CiEvents, DeliveryPolicy } from './filter.js';
import { worthWaking } from './filter.js';

const pr: PrRef = { repo: 'acme-labs/widget-service', prNumber: 42 };

const DEFAULT_POLICY = resolveTracking(DEFAULT_CONFIG, {}, null).policy;

function policy(overrides: Partial<DeliveryPolicy> = {}): DeliveryPolicy {
  return { ...DEFAULT_POLICY, ...overrides };
}

function withWake(wake: CiEvents): DeliveryPolicy {
  return policy({ checks: { enabled: true, wake } });
}

// The deploy workflow is off until an operator names one, so every test about it says so.
function withDeploy(wake: CiEvents): DeliveryPolicy {
  return policy({ checks: { enabled: true, wake }, deployWorkflow: { enabled: true } });
}

function comment(text: string, stale = false): EnvelopeOf<'pr_comment'> {
  return {
    id: newEventId(),
    deliveryId: `d-${text}`,
    prRef: pr,
    receivedAtIso: '2026-09-09T10:00:00.000Z',
    headSha: 'a'.repeat(40),
    stale,
    kind: 'pr_comment',
    payload: {
      kind: 'pr_comment',
      prRef: pr,
      headSha: null,
      actorLogin: 'sam-reviewer',
      occurredAtIso: '2026-09-09T10:00:00.000Z',
      htmlUrl: null,
      action: 'created',
      commentId: 1,
      untrustedBody: untrusted(text),
    },
  };
}

function envelopeOf<K extends PrEventKind>(kind: K, payload: object): EnvelopeOf<K> {
  return { ...comment('x'), kind, payload: { kind, prRef: pr, ...payload } } as unknown as EnvelopeOf<K>;
}

function check(state: object): EnvelopeOf<'ci_check'> {
  return envelopeOf('ci_check', {
    headSha: 'a'.repeat(40), actorLogin: null,
    occurredAtIso: '2026-09-09T10:00:00.000Z', htmlUrl: null,
    checkName: 'ci/lint', checkRunId: 1, state, detailsUrl: null,
  });
}

function allGreen(): EnvelopeOf<'ci_all_required_green'> {
  return envelopeOf('ci_all_required_green', {
    headSha: 'a'.repeat(40), actorLogin: null,
    occurredAtIso: '2026-09-09T10:00:00.000Z', htmlUrl: null, checkNames: ['ci/lint'],
  });
}

function deploy(conclusion: string): EnvelopeOf<'deploy_workflow'> {
  return envelopeOf('deploy_workflow', {
    headSha: 'a'.repeat(40), actorLogin: null,
    occurredAtIso: '2026-09-09T10:00:00.000Z', htmlUrl: null,
    workflowName: 'Ship It', workflowRunId: 9, runAttempt: 1,
    state: { status: 'completed', conclusion },
  });
}

function deployRunning(status: 'requested' | 'queued' | 'in_progress'): EnvelopeOf<'deploy_workflow'> {
  return { ...deploy('success'), payload: { ...deploy('success').payload, state: { status } } } as EnvelopeOf<'deploy_workflow'>;
}

function review(): EnvelopeOf<'pr_review'> {
  return envelopeOf('pr_review', {
    headSha: 'a'.repeat(40), actorLogin: 'sam-reviewer',
    occurredAtIso: '2026-09-09T10:00:00.000Z', htmlUrl: null,
    action: 'submitted', reviewId: 3, reviewState: 'changes_requested', untrustedBody: untrusted('fix'),
  });
}

function reviewComment(): EnvelopeOf<'pr_review_comment'> {
  return envelopeOf('pr_review_comment', {
    headSha: 'a'.repeat(40), actorLogin: 'sam-reviewer',
    occurredAtIso: '2026-09-09T10:00:00.000Z', htmlUrl: null,
    action: 'created', commentId: 4, reviewId: null, inReplyToId: null,
    path: 'src/cart.js', line: 2, untrustedBody: untrusted('here'),
  });
}

function lifecycle(action: PrLifecycleAction): EnvelopeOf<'pr_lifecycle'> {
  return envelopeOf('pr_lifecycle', {
    headSha: 'a'.repeat(40), actorLogin: 'sam-reviewer',
    occurredAtIso: '2026-09-09T10:00:00.000Z', htmlUrl: null,
    action, draft: false, baseRef: 'main', headRef: 'feature',
    untrustedTitle: untrusted('title'), untrustedSubject: null,
  });
}

describe('worthWaking', () => {
  // A push with twenty checks fires sixty transitions; "ci/lint is queued" says nothing
  // a session can act on.
  it('never wakes for a check that has not finished', () => {
    for (const wake of ['completed', 'failures'] as const) {
      expect(worthWaking(check({ status: 'queued' }), withWake(wake))).toBe(false);
      expect(worthWaking(check({ status: 'in_progress' }), withWake(wake))).toBe(false);
    }
  });

  it('delivers every finished check by default, pass or fail', () => {
    expect(worthWaking(check({ status: 'completed', conclusion: 'success' }), withWake('completed'))).toBe(true);
    expect(worthWaking(check({ status: 'completed', conclusion: 'failure' }), withWake('completed'))).toBe(true);
  });

  it('failures narrows to the ones that finished badly; all reinstates the pending states', () => {
    expect(worthWaking(check({ status: 'completed', conclusion: 'success' }), withWake('failures'))).toBe(false);
    expect(worthWaking(check({ status: 'completed', conclusion: 'failure' }), withWake('failures'))).toBe(true);
    expect(worthWaking(check({ status: 'completed', conclusion: 'timed_out' }), withWake('failures'))).toBe(true);
    expect(worthWaking(check({ status: 'queued' }), withWake('all'))).toBe(true);
  });

  // A successful run is the signal that work depending on what it builds can start. A
  // failed one is not this session's to chase, so it never interrupts.
  it('wakes for a successful deploy workflow but not a failed one', () => {
    expect(worthWaking(deploy('success'), withDeploy('completed'))).toBe(true);
    expect(worthWaking(deploy('failure'), withDeploy('completed'))).toBe(false);
    expect(worthWaking(deploy('failure'), withDeploy('failures'))).toBe(false);
  });

  // checks.wake decides CI checks, not this: the README and the track skill both promise
  // a failed or still-running deploy run never reaches the session, with no escape hatch.
  it('keeps a failed or unfinished deploy workflow silent even under wake "all"', () => {
    expect(worthWaking(deploy('failure'), withDeploy('all'))).toBe(false);
    expect(worthWaking(deploy('timed_out'), withDeploy('all'))).toBe(false);
    expect(worthWaking(deploy('cancelled'), withDeploy('all'))).toBe(false);
    for (const status of ['requested', 'queued', 'in_progress'] as const) {
      expect(worthWaking(deployRunning(status), withDeploy('all'))).toBe(false);
      expect(worthWaking(deployRunning(status), withDeploy('completed'))).toBe(false);
    }
    expect(worthWaking(deploy('success'), withDeploy('all'))).toBe(true);
  });

  it('never wakes for a deploy workflow that is turned off, however green', () => {
    const off = policy({ deployWorkflow: { enabled: false } });
    expect(worthWaking(deploy('success'), off)).toBe(false);
    expect(worthWaking(deploy('failure'), { ...off, checks: { enabled: true, wake: 'all' } })).toBe(false);
  });

  it('suppresses each kind that is turned off, and nothing else', () => {
    const cases = [
      { envelope: comment('please fix'), off: policy({ comments: false }) },
      { envelope: review(), off: policy({ reviews: false }) },
      { envelope: reviewComment(), off: policy({ reviewComments: false }) },
      { envelope: check({ status: 'completed', conclusion: 'failure' }), off: policy({ checks: { enabled: false, wake: 'completed' } }) },
      { envelope: allGreen(), off: policy({ requiredChecks: { enabled: false } }) },
    ] as const;
    for (const { envelope, off } of cases) {
      expect(worthWaking(envelope, policy({ deployWorkflow: { enabled: true } }))).toBe(true);
      expect(worthWaking(envelope, off)).toBe(false);
    }
  });

  it('decides each lifecycle action on its own key', () => {
    expect(worthWaking(lifecycle('synchronize'), DEFAULT_POLICY)).toBe(true);
    expect(worthWaking(lifecycle('labeled'), DEFAULT_POLICY)).toBe(false);

    const swapped = policy({ lifecycle: { ...DEFAULT_POLICY.lifecycle, synchronize: false, labeled: true } });
    expect(worthWaking(lifecycle('synchronize'), swapped)).toBe(false);
    expect(worthWaking(lifecycle('labeled'), swapped)).toBe(true);
  });
});
