import { describe, expect, it } from 'bun:test';
import { newEventId } from '../events/ids.js';
import type { EnvelopeOf, PrRef } from '../types.js';
import { untrusted } from '../types.js';
import { describeEvent } from './describe.js';

const pr: PrRef = { repo: 'toptal/example', prNumber: 42 };
const head = 'a'.repeat(40);
const otherHead = 'b'.repeat(40);

function base(stale: boolean, headSha: string | null) {
  return {
    id: newEventId(),
    deliveryId: 'd1',
    prRef: pr,
    receivedAtIso: '2026-09-09T10:00:00.000Z',
    headSha,
    stale,
  };
}

function check(headSha: string, conclusion: 'success' | 'failure', stale = false): EnvelopeOf<'ci_check'> {
  return {
    ...base(stale, headSha),
    kind: 'ci_check',
    payload: {
      kind: 'ci_check', prRef: pr, headSha, actorLogin: null,
      occurredAtIso: '2026-09-09T10:00:00.000Z', htmlUrl: null,
      checkName: 'ci/test', checkRunId: 1,
      state: { status: 'completed', conclusion }, detailsUrl: null,
    },
  };
}

function allGreen(headSha: string, stale = false): EnvelopeOf<'ci_all_required_green'> {
  return {
    ...base(stale, headSha),
    kind: 'ci_all_required_green',
    payload: {
      kind: 'ci_all_required_green', prRef: pr, headSha, actorLogin: null,
      occurredAtIso: '2026-09-09T10:00:00.000Z', htmlUrl: null, checkNames: ['ci/test'],
    },
  };
}

function temploy(headSha: string, stale = false): EnvelopeOf<'temploy_workflow'> {
  return {
    ...base(stale, headSha),
    kind: 'temploy_workflow',
    payload: {
      kind: 'temploy_workflow', prRef: pr, headSha, actorLogin: null,
      occurredAtIso: '2026-09-09T10:00:00.000Z', htmlUrl: null,
      workflowRunId: 3, runAttempt: 1, state: { status: 'completed', conclusion: 'success' },
    },
  };
}

function lifecycle(headSha: string, stale = false): EnvelopeOf<'pr_lifecycle'> {
  return {
    ...base(stale, headSha),
    kind: 'pr_lifecycle',
    payload: {
      kind: 'pr_lifecycle', prRef: pr, headSha, actorLogin: 'octocat',
      occurredAtIso: '2026-09-09T10:00:00.000Z', htmlUrl: null,
      action: 'synchronize', draft: false, baseRef: 'main', headRef: 'feature',
      untrustedTitle: untrusted('title'),
    },
  };
}

describe('describeEvent', () => {
  // A head can advance between an event being normalized and it being pushed, so the
  // verdict is taken against the head held now.
  it('decides staleness against the head held now, not the flag on the envelope', () => {
    expect(describeEvent(check(otherHead, 'success', false), head)).toMatchObject({
      stale: true,
      headConfirmed: false,
    });
    expect(describeEvent(check(head, 'success', true), head)).toMatchObject({
      stale: false,
      headConfirmed: true,
    });
  });

  it('never calls a lifecycle event stale, since it defines the head', () => {
    expect(describeEvent(lifecycle(otherHead), head)).toMatchObject({ stale: false, headConfirmed: true });
  });

  it('falls back to the envelope flag while no head is known, and only vouches for lifecycle', () => {
    expect(describeEvent(check(head, 'success', true), null)).toMatchObject({
      stale: true,
      headConfirmed: false,
    });
    expect(describeEvent(lifecycle(head), null)).toMatchObject({ stale: false, headConfirmed: true });
  });

  it('suppresses every positive signal for a head that is not current', () => {
    for (const envelope of [check(otherHead, 'success'), allGreen(otherHead), temploy(otherHead)]) {
      expect(describeEvent(envelope, head)).toMatchObject({ positiveSignalSuppressed: true });
    }
    // A failure is news whatever head it is about, and a comment is not a signal at all.
    expect(describeEvent(check(otherHead, 'failure'), head)).toMatchObject({ positiveSignalSuppressed: false });
    for (const envelope of [check(head, 'success'), allGreen(head), temploy(head)]) {
      expect(describeEvent(envelope, head)).toMatchObject({ positiveSignalSuppressed: false });
    }
  });
});
