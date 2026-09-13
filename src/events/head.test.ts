import { describe, expect, it } from 'bun:test';
import type { CiCheckEvent, PrEvent, PrLifecycleAction, PrRef, WorkflowEvent } from '../types.js';
import { isPositiveHeadSignal, untrusted } from '../types.js';
import { HeadTracker } from './head.js';

const pr: PrRef = { repo: 'acme-labs/example', prNumber: 42 };
const sha1 = '1'.repeat(40);
const sha2 = '2'.repeat(40);
const sha3 = '3'.repeat(40);

function ciGreen(headSha: string, checkName = 'test'): CiCheckEvent {
  return {
    kind: 'ci_check',
    prRef: pr,
    headSha,
    actorLogin: null,
    occurredAtIso: '2026-09-07T10:00:00.000Z',
    htmlUrl: null,
    checkName,
    checkRunId: 1,
    state: { status: 'completed', conclusion: 'success' },
    detailsUrl: null,
  };
}

function deployReady(headSha: string): WorkflowEvent {
  return {
    kind: 'workflow',
    prRef: pr,
    headSha,
    actorLogin: null,
    occurredAtIso: '2026-09-07T10:00:00.000Z',
    htmlUrl: null,
    workflowName: 'Build Preview Image',
    workflowRunId: 5,
    runAttempt: 1,
    state: { status: 'completed', conclusion: 'success' },
  };
}

function lifecycle(
  action: PrLifecycleAction,
  headSha: string | null,
  draft = false,
  occurredAtIso = '2026-09-07T10:00:00.000Z',
): PrEvent {
  return {
    kind: 'pr_lifecycle',
    prRef: pr,
    headSha,
    actorLogin: 'octocat',
    occurredAtIso,
    htmlUrl: null,
    action,
    draft,
    baseRef: 'main',
    headRef: 'feature',
    untrustedTitle: untrusted('title'),
    untrustedSubject: null,
  };
}

function comment(headSha: string | null): PrEvent {
  return {
    kind: 'pr_comment',
    prRef: pr,
    headSha,
    actorLogin: 'someone',
    occurredAtIso: '2026-09-07T10:00:00.000Z',
    htmlUrl: null,
    action: 'created',
    commentId: 9,
    untrustedBody: untrusted('hi'),
  };
}

function tracked(headSha: string | null, atIso = '2026-09-07T09:00:00.000Z'): HeadTracker {
  const head = new HeadTracker({ repo: 'Acme-Labs/Example', prNumber: 42 }, 'open');
  head.seed(headSha, atIso);
  return head;
}

describe('classification', () => {
  it('marks events for the current head fresh and for any other head stale', () => {
    const head = tracked(sha2);
    expect(head.classify(ciGreen(sha2))).toMatchObject({ stale: false, headKnown: true });
    expect(head.classify(ciGreen(sha1))).toMatchObject({
      stale: true,
      headKnown: true,
      suppressedPositiveSignal: true,
    });
    expect(head.classify(comment(sha1))).toMatchObject({ stale: true, suppressedPositiveSignal: false });
    expect(head.classify(comment(null))).toMatchObject({ stale: false });
  });

  it('never treats a lifecycle event as stale, since it defines the head', () => {
    expect(tracked(sha1).classify(lifecycle('synchronize', sha2))).toMatchObject({ stale: false });
  });

  it('cannot call anything stale while the head is unknown, and says so', () => {
    expect(tracked(null).classify(ciGreen(sha1))).toMatchObject({ stale: false, headKnown: false });
  });

  it('canonicalizes the repo it was constructed with', () => {
    expect(tracked(sha1).prRef).toEqual(pr);
  });
});

describe('head tracking', () => {
  it('advances the head on synchronize and updates lifecycle state', () => {
    const head = tracked(sha1);
    expect(head.apply(lifecycle('synchronize', sha2))).toMatchObject({ headAdvanced: true, lifecycle: 'open' });
    expect(head.headSha).toBe(sha2);
    expect(head.apply(lifecycle('synchronize', sha2))).toMatchObject({ headAdvanced: false });
    expect(head.apply(lifecycle('converted_to_draft', sha2, true))).toMatchObject({ lifecycle: 'draft' });
    expect(head.lifecycle).toBe('draft');
    expect(head.apply(lifecycle('ready_for_review', sha2))).toMatchObject({ lifecycle: 'open' });
    expect(head.apply(ciGreen(sha2))).toMatchObject({ headAdvanced: false, lifecycle: null, closed: false });
  });

  it('adopts the head from the first lifecycle event when seeded without one', () => {
    const head = tracked(null);
    expect(head.apply(lifecycle('opened', sha1, true))).toMatchObject({ headAdvanced: true, lifecycle: 'draft' });
    expect(head.headSha).toBe(sha1);
    expect(head.headSource).toBe('lifecycle');
  });

  it('closes on closed and merged and leaves a closed tracker untouched', () => {
    const head = tracked(sha1);
    expect(head.apply(lifecycle('merged', sha1))).toMatchObject({ lifecycle: 'merged', closed: true, terminal: 'merged' });
    expect(head.closed).toBe(true);
    expect(head.apply(lifecycle('synchronize', sha2))).toMatchObject({ headAdvanced: false, lifecycle: null });
    expect(head.headSha).toBe(sha1);
  });
});

describe('the superseded-head invariant', () => {
  it('a green signal for the old head arriving after synchronize is stale and suppressed', () => {
    const head = tracked(sha1);
    expect(head.classify(ciGreen(sha1))).toMatchObject({ stale: false, suppressedPositiveSignal: false });

    head.apply(lifecycle('synchronize', sha2));

    for (const late of [ciGreen(sha1), deployReady(sha1)]) {
      expect(isPositiveHeadSignal(late)).toBe(true);
      expect(head.classify(late)).toMatchObject({ stale: true, suppressedPositiveSignal: true });
    }
    for (const current of [ciGreen(sha2), deployReady(sha2)]) {
      expect(head.classify(current)).toMatchObject({ stale: false, suppressedPositiveSignal: false });
    }
  });
});

describe('head monotonicity', () => {
  it('ignores a lifecycle event that would rewind the head to a sha the PR already left', () => {
    const head = tracked(sha1);
    expect(head.apply(lifecycle('synchronize', sha2))).toMatchObject({ headAdvanced: true });

    // The delayed synchronize for the earlier push, delivered out of order.
    expect(head.apply(lifecycle('synchronize', sha1))).toMatchObject({ headAdvanced: false });
    expect(head.headSha).toBe(sha2);

    expect(head.classify(ciGreen(sha1))).toMatchObject({ stale: true, suppressedPositiveSignal: true });
    expect(head.classify(ciGreen(sha2))).toMatchObject({ stale: false, suppressedPositiveSignal: false });
  });

  it('ignores a lifecycle event older than the one that set the current head', () => {
    const head = tracked(sha1);
    head.apply(lifecycle('synchronize', sha2, false, '2026-09-07T10:10:00.000Z'));
    expect(head.headSha).toBe(sha2);

    // A never-seen sha, but from a delivery that predates the one in force.
    expect(head.apply(lifecycle('synchronize', sha3, false, '2026-09-07T10:05:00.000Z'))).toMatchObject({
      headAdvanced: false,
    });
    expect(head.headSha).toBe(sha2);

    expect(head.apply(lifecycle('synchronize', sha3, false, '2026-09-07T10:20:00.000Z'))).toMatchObject({
      headAdvanced: true,
    });
    expect(head.headSha).toBe(sha3);
  });

  it('follows a force-push back to a sha the PR previously left', () => {
    const head = tracked(sha1);
    head.apply(lifecycle('synchronize', sha2, false, '2026-09-07T10:01:00.000Z'));
    expect(head.headSha).toBe(sha2);

    // `git reset --hard <sha1> && git push --force-with-lease`: the head GitHub reports is
    // one this PR held before, and it is the head the PR actually has now.
    expect(head.apply(lifecycle('synchronize', sha1, false, '2026-09-07T10:10:00.000Z'))).toMatchObject({
      headAdvanced: true,
    });
    expect(head.headSha).toBe(sha1);
    expect(head.classify(ciGreen(sha1))).toMatchObject({ stale: false, suppressedPositiveSignal: false });
    expect(head.classify(ciGreen(sha2))).toMatchObject({ stale: true, suppressedPositiveSignal: true });
  });

  it('lets a lifecycle delivery correct a seeded head whatever the two clocks say', () => {
    const head = tracked(sha2, '2026-09-07T10:15:00.000Z');
    expect(head.headEventAtIso).toBe('2026-09-07T10:15:00.000Z');

    // The seeded head is a clone's guess stamped with the worker's own clock. GitHub's
    // account of the head outranks it, or a clone one push behind pins tracking to a
    // dead commit.
    expect(head.apply(lifecycle('synchronize', sha1, false, '2026-09-07T10:10:00.000Z'))).toMatchObject({
      headAdvanced: true,
    });
    expect(head.headSha).toBe(sha1);
    expect(head.classify(ciGreen(sha2))).toMatchObject({ stale: true, suppressedPositiveSignal: true });

    // Between two lifecycle deliveries the older one is still refused.
    expect(head.apply(lifecycle('synchronize', sha3, false, '2026-09-07T10:05:00.000Z'))).toMatchObject({
      headAdvanced: false,
    });
    expect(head.headSha).toBe(sha1);

    expect(head.apply(lifecycle('synchronize', sha3, false, '2026-09-07T10:20:00.000Z'))).toMatchObject({
      headAdvanced: true,
    });
  });

  it("keeps the head's provenance and ordering stamp when the same head is seeded again", () => {
    const head = tracked(sha1);
    head.apply(lifecycle('synchronize', sha2, false, '2026-09-07T10:20:00.000Z'));

    expect(head.seed(sha2, '2026-09-07T10:25:00.000Z')).toEqual({ accepted: null, ignored: null });
    expect(head.headSource).toBe('lifecycle');
    expect(head.headEventAtIso).toBe('2026-09-07T10:20:00.000Z');

    // The delayed synchronize for the earlier push must still be refused afterwards.
    expect(head.apply(lifecycle('synchronize', sha3, false, '2026-09-07T10:10:00.000Z'))).toMatchObject({
      headAdvanced: false,
    });
    expect(head.headSha).toBe(sha2);
  });

  it('refuses a seeded head that GitHub has already superseded', () => {
    const head = tracked(sha1);
    head.apply(lifecycle('synchronize', sha2));

    expect(head.seed(sha1)).toEqual({ accepted: null, ignored: sha1 });
    expect(head.headSha).toBe(sha2);
    expect(head.classify(ciGreen(sha1))).toMatchObject({ stale: true, suppressedPositiveSignal: true });
  });

  it('refuses any seeded head once one came from a lifecycle event', () => {
    const head = tracked(null);
    head.apply(lifecycle('opened', sha1));
    expect(head.headSource).toBe('lifecycle');

    expect(head.seed(sha3)).toEqual({ accepted: null, ignored: sha3 });
    expect(head.headSha).toBe(sha1);
  });

  it('still lets a seed correct a head it asserted itself', () => {
    const head = tracked(sha1);
    expect(head.seed(sha2)).toEqual({ accepted: sha2, ignored: null });
    expect(head.headSha).toBe(sha2);
    expect(head.headSource).toBe('registration');
  });
});

describe('an unknown head', () => {
  it('suppresses positive signals, because no head can be vouched for', () => {
    const head = tracked(null);
    for (const positive of [ciGreen(sha1), deployReady(sha1)]) {
      expect(head.classify(positive)).toMatchObject({
        stale: false,
        headKnown: false,
        suppressedPositiveSignal: true,
      });
    }
    expect(head.classify(comment(sha1))).toMatchObject({ suppressedPositiveSignal: false });

    head.apply(lifecycle('synchronize', sha1));
    expect(head.classify(ciGreen(sha1))).toMatchObject({ headKnown: true, suppressedPositiveSignal: false });
  });
});

describe('prsByHead', () => {
  it('claims a delivery for any head this PR has held, and nothing else', () => {
    const head = tracked(sha1);
    head.apply(lifecycle('synchronize', sha2));
    expect(head.prsByHead('Acme-Labs/Example', sha2)).toEqual([pr]);
    // A check can outrun the synchronize for its own head, and a head the PR has left
    // still belongs to it.
    expect(head.prsByHead('acme-labs/example', sha1)).toEqual([pr]);
    expect(head.prsByHead('acme-labs/example', sha3)).toEqual([]);
    expect(head.prsByHead('acme-labs/other', sha1)).toEqual([]);
  });
});
