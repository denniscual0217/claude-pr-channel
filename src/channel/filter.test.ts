import { describe, expect, it } from 'bun:test';
import { newEventId } from '../events/ids.js';
import type { EnvelopeOf, PrRef } from '../types.js';
import { untrusted } from '../types.js';
import { worthWaking } from './filter.js';

const pr: PrRef = { repo: 'acme-labs/widget-service', prNumber: 42 };

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

function check(state: object): EnvelopeOf<'ci_check'> {
  return {
    ...comment('x'),
    kind: 'ci_check',
    payload: {
      kind: 'ci_check', prRef: pr, headSha: 'a'.repeat(40), actorLogin: null,
      occurredAtIso: '2026-09-09T10:00:00.000Z', htmlUrl: null,
      checkName: 'ci/lint', checkRunId: 1, state, detailsUrl: null,
    },
  } as EnvelopeOf<'ci_check'>;
}

function temploy(conclusion: string): EnvelopeOf<'temploy_workflow'> {
  return {
    ...comment('x'),
    kind: 'temploy_workflow',
    payload: {
      kind: 'temploy_workflow', prRef: pr, headSha: 'a'.repeat(40), actorLogin: null,
      occurredAtIso: '2026-09-09T10:00:00.000Z', htmlUrl: null,
      workflowRunId: 9, runAttempt: 1, state: { status: 'completed', conclusion },
    },
  } as EnvelopeOf<'temploy_workflow'>;
}

describe('worthWaking', () => {
  // A push with twenty checks fires sixty transitions; "ci/lint is queued" says nothing
  // a session can act on.
  it('never wakes for a check that has not finished', () => {
    for (const mode of ['completed', 'failures'] as const) {
      expect(worthWaking(check({ status: 'queued' }), mode)).toBe(false);
      expect(worthWaking(check({ status: 'in_progress' }), mode)).toBe(false);
    }
  });

  it('delivers every finished check by default, pass or fail', () => {
    expect(worthWaking(check({ status: 'completed', conclusion: 'success' }), 'completed')).toBe(true);
    expect(worthWaking(check({ status: 'completed', conclusion: 'failure' }), 'completed')).toBe(true);
  });

  it('failures narrows to the ones that finished badly; all reinstates the pending states', () => {
    expect(worthWaking(check({ status: 'completed', conclusion: 'success' }), 'failures')).toBe(false);
    expect(worthWaking(check({ status: 'completed', conclusion: 'failure' }), 'failures')).toBe(true);
    expect(worthWaking(check({ status: 'completed', conclusion: 'timed_out' }), 'failures')).toBe(true);
    expect(worthWaking(check({ status: 'queued' }), 'all')).toBe(true);
  });

  // A successful image is the signal that image-dependent work can start. A failed
  // Temploy build is not this session's to chase, so it never interrupts.
  it('wakes for a built Temploy image but not a failed one', () => {
    expect(worthWaking(temploy('success'), 'completed')).toBe(true);
    expect(worthWaking(temploy('failure'), 'completed')).toBe(false);
    expect(worthWaking(temploy('failure'), 'failures')).toBe(false);
    expect(worthWaking(temploy('failure'), 'all')).toBe(true);
  });

  it('never suppresses a comment, review or lifecycle event', () => {
    for (const mode of ['failures', 'completed', 'all'] as const) {
      expect(worthWaking(comment('please fix'), mode)).toBe(true);
    }
  });
});
