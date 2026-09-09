import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelDb } from '../store/db.js';
import type { CiAllRequiredGreenEvent, CiCheckEvent, PrEvent, PrLifecycleAction, PrRef, TemployWorkflowEvent } from '../types.js';
import { isPositiveHeadSignal, untrusted } from '../types.js';
import { PrRegistry } from './registry.js';

const pr: PrRef = { repo: 'toptal/example', prNumber: 42 };
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

function allGreen(headSha: string): CiAllRequiredGreenEvent {
  return {
    kind: 'ci_all_required_green',
    prRef: pr,
    headSha,
    actorLogin: null,
    occurredAtIso: '2026-09-07T10:00:00.000Z',
    htmlUrl: null,
    checkNames: ['test'],
  };
}

function temployReady(headSha: string): TemployWorkflowEvent {
  return {
    kind: 'temploy_workflow',
    prRef: pr,
    headSha,
    actorLogin: null,
    occurredAtIso: '2026-09-07T10:00:00.000Z',
    htmlUrl: null,
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

let dir: string;
let db: ChannelDb;
let registry: PrRegistry;
let clock: Date;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pr-channel-registry-'));
  db = ChannelDb.open(join(dir, 'channel.db'));
  clock = new Date('2026-09-07T09:00:00.000Z');
  registry = new PrRegistry(db, { now: () => clock });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('registration', () => {
  it('registers a session for a PR and canonicalizes the repo', () => {
    const result = registry.register({ prRef: { repo: 'Toptal/Example', prNumber: 42 }, sessionId: 's1', headSha: sha1 });
    expect(result).toMatchObject({ ok: true, replaced: null, route: { prRef: pr, sessionId: 's1', headSha: sha1 } });
    expect(registry.getRoute(pr)).toMatchObject({ sessionId: 's1', lifecycle: 'open', closed: false });
    expect(registry.getRouteBySession('s1')).toMatchObject({ prRef: pr });
    expect(registry.currentHead(pr)).toBe(sha1);
  });

  it('rejects a second session for the same PR explicitly', () => {
    registry.register({ prRef: pr, sessionId: 's1', headSha: sha1 });
    const result = registry.register({ prRef: pr, sessionId: 's2' });
    expect(result).toMatchObject({ ok: false, reason: 'conflict', existing: { sessionId: 's1' } });
    expect(registry.getRoute(pr)?.sessionId).toBe('s1');
  });

  it('lets the same session re-register idempotently and keeps the head when none is given', () => {
    registry.register({ prRef: pr, sessionId: 's1', headSha: sha1 });
    expect(registry.register({ prRef: pr, sessionId: 's1' })).toMatchObject({ ok: true, route: { headSha: sha1 } });
    expect(registry.register({ prRef: pr, sessionId: 's1', headSha: sha2 })).toMatchObject({
      ok: true,
      route: { headSha: sha2 },
    });
  });

  it('allows an explicit takeover and reports the displaced route', () => {
    registry.register({ prRef: pr, sessionId: 's1', headSha: sha1 });
    expect(registry.register({ prRef: pr, sessionId: 's2', replace: true })).toMatchObject({
      ok: true,
      route: { sessionId: 's2', headSha: sha1 },
      replaced: { sessionId: 's1' },
    });
  });

  it('allows a fresh registration after the PR route closed', () => {
    registry.register({ prRef: pr, sessionId: 's1', headSha: sha1 });
    registry.closeRoute(pr, { lifecycle: 'merged' });
    expect(registry.getRoute(pr)).toMatchObject({ closed: true, lifecycle: 'merged' });
    expect(registry.register({ prRef: pr, sessionId: 's2' })).toMatchObject({
      ok: true,
      route: { sessionId: 's2', closed: false, lifecycle: 'open' },
    });
  });

  it('deregisters only for the owning session', () => {
    registry.register({ prRef: pr, sessionId: 's1' });
    expect(registry.deregister(pr, 's2')).toBe('session_mismatch');
    expect(registry.deregister(pr, 's1')).toBe('deregistered');
    expect(registry.deregister(pr, 's1')).toBe('not_registered');
    expect(registry.getRoute(pr)).toBeNull();
  });

  it('finds open PRs by head sha', () => {
    registry.register({ prRef: pr, sessionId: 's1', headSha: sha1 });
    registry.register({ prRef: { repo: 'toptal/other', prNumber: 1 }, sessionId: 's2', headSha: sha1 });
    expect(registry.findOpenPrsByHead('Toptal/Example', sha1)).toEqual([pr]);
    expect(registry.findOpenPrsByHead('toptal/example', sha2)).toEqual([]);
    registry.closeRoute(pr, { lifecycle: 'closed' });
    expect(registry.findOpenPrsByHead('toptal/example', sha1)).toEqual([]);
  });
});

describe('closeRoute', () => {
  it('closes once, honours the session guard and keeps the row observable', () => {
    registry.register({ prRef: pr, sessionId: 's1' });
    expect(registry.closeRoute(pr, { lifecycle: 'closed', sessionId: 'other' })).toBe(false);
    expect(registry.closeRoute(pr, { lifecycle: 'closed', sessionId: 's1' })).toBe(true);
    expect(registry.closeRoute(pr, { lifecycle: 'closed' })).toBe(false);
    expect(registry.getRouteBySession('s1')).toMatchObject({ closed: true, lifecycle: 'closed' });
    expect(registry.listOpenRoutes()).toEqual([]);
  });
});

describe('classification', () => {
  it('reports no_route and route_closed', () => {
    expect(registry.classify(ciGreen(sha1))).toEqual({ routed: false, reason: 'no_route', route: null });
    registry.register({ prRef: pr, sessionId: 's1', headSha: sha1 });
    registry.closeRoute(pr, { lifecycle: 'merged' });
    expect(registry.classify(ciGreen(sha1))).toMatchObject({ routed: false, reason: 'route_closed' });
  });

  it('marks events for the current head fresh and for any other head stale', () => {
    registry.register({ prRef: pr, sessionId: 's1', headSha: sha2 });
    expect(registry.classify(ciGreen(sha2))).toMatchObject({ routed: true, stale: false, headKnown: true });
    expect(registry.classify(ciGreen(sha1))).toMatchObject({
      routed: true,
      stale: true,
      headKnown: true,
      suppressedPositiveSignal: true,
    });
    expect(registry.classify(comment(sha1))).toMatchObject({ stale: true, suppressedPositiveSignal: false });
    expect(registry.classify(comment(null))).toMatchObject({ stale: false });
  });

  it('never treats a lifecycle event as stale, since it defines the head', () => {
    registry.register({ prRef: pr, sessionId: 's1', headSha: sha1 });
    expect(registry.classify(lifecycle('synchronize', sha2))).toMatchObject({ routed: true, stale: false });
  });

  it('cannot call anything stale while the head is unknown, and says so', () => {
    registry.register({ prRef: pr, sessionId: 's1' });
    expect(registry.classify(ciGreen(sha1))).toMatchObject({ routed: true, stale: false, headKnown: false });
  });
});

describe('head tracking', () => {
  it('advances the head on synchronize and updates lifecycle state', () => {
    registry.register({ prRef: pr, sessionId: 's1', headSha: sha1 });
    expect(registry.apply(lifecycle('synchronize', sha2))).toEqual({ headAdvanced: true, lifecycle: 'open', closed: false });
    expect(registry.currentHead(pr)).toBe(sha2);
    expect(registry.apply(lifecycle('synchronize', sha2))).toMatchObject({ headAdvanced: false });
    expect(registry.apply(lifecycle('converted_to_draft', sha2, true))).toMatchObject({ lifecycle: 'draft' });
    expect(registry.getRoute(pr)?.lifecycle).toBe('draft');
    expect(registry.apply(lifecycle('ready_for_review', sha2))).toMatchObject({ lifecycle: 'open' });
    expect(registry.apply(ciGreen(sha2))).toEqual({ headAdvanced: false, lifecycle: null, closed: false });
  });

  it('adopts the head from the first lifecycle event when registered without one', () => {
    registry.register({ prRef: pr, sessionId: 's1' });
    expect(registry.apply(lifecycle('opened', sha1, true))).toMatchObject({ headAdvanced: true, lifecycle: 'draft' });
    expect(registry.currentHead(pr)).toBe(sha1);
  });

  it('closes the route on closed and merged and leaves a closed route untouched', () => {
    registry.register({ prRef: pr, sessionId: 's1', headSha: sha1 });
    expect(registry.apply(lifecycle('merged', sha1))).toEqual({ headAdvanced: false, lifecycle: 'merged', closed: true });
    expect(registry.getRoute(pr)).toMatchObject({ closed: true, lifecycle: 'merged' });
    expect(registry.apply(lifecycle('synchronize', sha2))).toEqual({ headAdvanced: false, lifecycle: null, closed: false });
    expect(registry.currentHead(pr)).toBeNull();
  });

  it('advanceHead only moves an open route to a different sha', () => {
    registry.register({ prRef: pr, sessionId: 's1', headSha: sha1 });
    expect(registry.advanceHead(pr, sha1)).toBe(false);
    expect(registry.advanceHead(pr, sha2)).toBe(true);
    registry.closeRoute(pr, { lifecycle: 'closed' });
    expect(registry.advanceHead(pr, sha1)).toBe(false);
  });
});

describe('the superseded-head invariant', () => {
  it('a green signal for the old head arriving after synchronize is stale and suppressed', () => {
    registry.register({ prRef: pr, sessionId: 's1', headSha: sha1 });

    const first = registry.classify(ciGreen(sha1));
    expect(first).toMatchObject({ routed: true, stale: false, suppressedPositiveSignal: false });

    registry.apply(lifecycle('synchronize', sha2));

    for (const late of [ciGreen(sha1), allGreen(sha1), temployReady(sha1)]) {
      expect(isPositiveHeadSignal(late)).toBe(true);
      expect(registry.classify(late)).toMatchObject({ routed: true, stale: true, suppressedPositiveSignal: true });
    }
    for (const current of [ciGreen(sha2), allGreen(sha2), temployReady(sha2)]) {
      expect(registry.classify(current)).toMatchObject({ routed: true, stale: false, suppressedPositiveSignal: false });
    }
  });

  it('holds end to end through route(): envelopes for the old head carry stale=true', () => {
    registry.register({ prRef: pr, sessionId: 's1', headSha: sha1 });

    const before = registry.route(ciGreen(sha1), { deliveryId: 'd1' });
    expect(before).toMatchObject({ outcome: 'enqueued', stale: false, envelope: { stale: false, headSha: sha1 } });

    const sync = registry.route(lifecycle('synchronize', sha2), { deliveryId: 'd2' });
    expect(sync).toMatchObject({ outcome: 'enqueued', stale: false, applied: { headAdvanced: true } });
    expect(registry.currentHead(pr)).toBe(sha2);

    const late = registry.route(allGreen(sha1), { deliveryId: 'd3' });
    expect(late).toMatchObject({ outcome: 'enqueued', stale: true, suppressedPositiveSignal: true });

    const fresh = registry.route(temployReady(sha2), { deliveryId: 'd4' });
    expect(fresh).toMatchObject({ outcome: 'enqueued', stale: false, suppressedPositiveSignal: false });

    const leased = db.leaseEvents('s1', { leaseMs: 1_000 });
    expect(leased.map((envelope) => [envelope.kind, envelope.headSha, envelope.stale])).toEqual([
      ['ci_check', sha1, false],
      ['pr_lifecycle', sha2, false],
      ['ci_all_required_green', sha1, true],
      ['temploy_workflow', sha2, false],
    ]);
    const positiveForCurrentHead = leased.filter(
      (envelope) => !envelope.stale && isPositiveHeadSignal(envelope.payload) && envelope.headSha === sha2,
    );
    expect(positiveForCurrentHead.map((envelope) => envelope.kind)).toEqual(['temploy_workflow']);
  });
});

describe('route()', () => {
  it('records unrouted events instead of broadcasting them', () => {
    expect(registry.route(comment(null), { deliveryId: 'd1' })).toEqual({ outcome: 'unrouted', reason: 'no_route' });
    registry.register({ prRef: pr, sessionId: 's1' });
    registry.closeRoute(pr, { lifecycle: 'closed' });
    expect(registry.route(comment(null), { deliveryId: 'd2' })).toEqual({ outcome: 'unrouted', reason: 'route_closed' });
    expect(db.countUnrouted(pr)).toBe(2);
    // d1 was parked before any session existed, so registering s1 replays it to s1.
    // d2 arrived after the route closed and stays parked: a closed route is not a
    // mailbox, and no later session inherits it.
    expect(db.countPending('s1')).toBe(1);
  });

  it('enqueues to the one registered session with the envelope kind matching the payload', () => {
    registry.register({ prRef: pr, sessionId: 's1', headSha: sha1 });
    registry.register({ prRef: { repo: 'toptal/example', prNumber: 43 }, sessionId: 's2', headSha: sha1 });
    const outcome = registry.route(comment(sha1), { deliveryId: 'd1', receivedAtIso: '2026-09-07T12:00:01.000Z' });
    expect(outcome).toMatchObject({
      outcome: 'enqueued',
      envelope: {
        deliveryId: 'd1',
        sessionId: 's1',
        prRef: pr,
        receivedAtIso: '2026-09-07T12:00:01.000Z',
        kind: 'pr_comment',
        payload: { kind: 'pr_comment' },
      },
    });
    expect(db.countPending('s1')).toBe(1);
    expect(db.countPending('s2')).toBe(0);
  });

  it('delivers the terminal lifecycle event and then closes the route', () => {
    registry.register({ prRef: pr, sessionId: 's1', headSha: sha1 });
    const outcome = registry.route(lifecycle('merged', sha1), { deliveryId: 'd1' });
    expect(outcome).toMatchObject({ outcome: 'enqueued', applied: { closed: true, lifecycle: 'merged' } });
    expect(registry.getRouteBySession('s1')).toMatchObject({ closed: true, lifecycle: 'merged' });
    expect(db.countPending('s1')).toBe(1);
    expect(registry.route(comment(null), { deliveryId: 'd2' })).toEqual({ outcome: 'unrouted', reason: 'route_closed' });
  });

  it('uses the injected clock for timestamps', () => {
    registry.register({ prRef: pr, sessionId: 's1', headSha: sha1 });
    clock = new Date('2026-09-08T00:00:00.000Z');
    const outcome = registry.route(lifecycle('synchronize', sha2), { deliveryId: 'd1' });
    expect(outcome).toMatchObject({ envelope: { receivedAtIso: '2026-09-08T00:00:00.000Z' } });
    expect(registry.getRoute(pr)?.updatedAtIso).toBe('2026-09-08T00:00:00.000Z');
  });
});

describe('head monotonicity', () => {
  it('ignores a lifecycle event that would rewind the head to a sha the PR already left', () => {
    registry.register({ prRef: pr, sessionId: 's1', headSha: sha1 });
    expect(registry.route(lifecycle('synchronize', sha2), { deliveryId: 'd1' })).toMatchObject({
      applied: { headAdvanced: true },
    });

    // The delayed synchronize for the earlier push, delivered out of order.
    const late = registry.route(lifecycle('synchronize', sha1), { deliveryId: 'd2' });
    expect(late).toMatchObject({ outcome: 'enqueued', applied: { headAdvanced: false } });
    expect(registry.currentHead(pr)).toBe(sha2);

    expect(registry.classify(ciGreen(sha1))).toMatchObject({ stale: true, suppressedPositiveSignal: true });
    expect(registry.classify(ciGreen(sha2))).toMatchObject({ stale: false, suppressedPositiveSignal: false });
  });

  it('ignores a lifecycle event older than the one that set the current head', () => {
    registry.register({ prRef: pr, sessionId: 's1', headSha: sha1 });
    registry.apply(lifecycle('synchronize', sha2, false, '2026-09-07T10:10:00.000Z'));
    expect(registry.currentHead(pr)).toBe(sha2);

    // A never-seen sha, but from a delivery that predates the one in force.
    expect(registry.apply(lifecycle('synchronize', sha3, false, '2026-09-07T10:05:00.000Z'))).toMatchObject({
      headAdvanced: false,
    });
    expect(registry.currentHead(pr)).toBe(sha2);

    expect(registry.apply(lifecycle('synchronize', sha3, false, '2026-09-07T10:20:00.000Z'))).toMatchObject({
      headAdvanced: true,
    });
    expect(registry.currentHead(pr)).toBe(sha3);
  });

  it('follows a force-push back to a sha the PR previously left', () => {
    registry.register({ prRef: pr, sessionId: 's1', headSha: sha1 });
    registry.apply(lifecycle('synchronize', sha2, false, '2026-09-07T10:01:00.000Z'));
    expect(registry.currentHead(pr)).toBe(sha2);

    // `git reset --hard <sha1> && git push --force-with-lease`: the head GitHub reports is
    // one this PR held before, and it is the head the PR actually has now.
    expect(registry.apply(lifecycle('synchronize', sha1, false, '2026-09-07T10:10:00.000Z'))).toMatchObject({
      headAdvanced: true,
    });
    expect(registry.currentHead(pr)).toBe(sha1);
    expect(registry.classify(ciGreen(sha1))).toMatchObject({ stale: false, suppressedPositiveSignal: false });
    expect(registry.classify(ciGreen(sha2))).toMatchObject({ stale: true, suppressedPositiveSignal: true });
  });

  it('lets a lifecycle delivery correct a registration head whatever the two clocks say', () => {
    clock = new Date('2026-09-07T10:15:00.000Z');
    registry.register({ prRef: pr, sessionId: 's1', headSha: sha2 });
    expect(registry.getRoute(pr)?.headEventAtIso).toBe('2026-09-07T10:15:00.000Z');

    // `--head` is a clone's guess stamped with the worker's own clock. GitHub's account of
    // the head outranks it, or a clone one push behind pins the route to a dead commit.
    expect(registry.apply(lifecycle('synchronize', sha1, false, '2026-09-07T10:10:00.000Z'))).toMatchObject({
      headAdvanced: true,
    });
    expect(registry.currentHead(pr)).toBe(sha1);
    expect(registry.classify(ciGreen(sha2))).toMatchObject({ stale: true, suppressedPositiveSignal: true });

    // Between two lifecycle deliveries the older one is still refused.
    expect(registry.apply(lifecycle('synchronize', sha3, false, '2026-09-07T10:05:00.000Z'))).toMatchObject({
      headAdvanced: false,
    });
    expect(registry.currentHead(pr)).toBe(sha1);

    expect(registry.apply(lifecycle('synchronize', sha3, false, '2026-09-07T10:20:00.000Z'))).toMatchObject({
      headAdvanced: true,
    });
  });

  it('keeps the head\'s provenance and ordering stamp when the same head is registered again', () => {
    registry.register({ prRef: pr, sessionId: 's1', headSha: sha1 });
    registry.apply(lifecycle('synchronize', sha2, false, '2026-09-07T10:20:00.000Z'));

    // The launcher re-runs its idempotent registration step; rev-parse now yields sha2.
    clock = new Date('2026-09-07T10:25:00.000Z');
    expect(registry.register({ prRef: pr, sessionId: 's1', headSha: sha2 })).toMatchObject({
      ok: true,
      ignoredHeadSha: null,
      route: { headSha: sha2, headSource: 'lifecycle', headEventAtIso: '2026-09-07T10:20:00.000Z' },
    });

    // The delayed synchronize for the earlier push must still be refused afterwards.
    expect(registry.apply(lifecycle('synchronize', sha3, false, '2026-09-07T10:10:00.000Z'))).toMatchObject({
      headAdvanced: false,
    });
    expect(registry.currentHead(pr)).toBe(sha2);
  });

  it('refuses a registration head that GitHub has already superseded', () => {
    registry.register({ prRef: pr, sessionId: 's1', headSha: sha1 });
    registry.apply(lifecycle('synchronize', sha2));

    // The launcher re-runs its idempotent registration from a clone that never fetched sha2.
    const again = registry.register({ prRef: pr, sessionId: 's1', headSha: sha1 });
    expect(again).toMatchObject({ ok: true, ignoredHeadSha: sha1, route: { headSha: sha2 } });
    expect(registry.currentHead(pr)).toBe(sha2);
    expect(registry.classify(ciGreen(sha1))).toMatchObject({ stale: true, suppressedPositiveSignal: true });
  });

  it('refuses any registration head once one came from a lifecycle event, unless --replace', () => {
    registry.register({ prRef: pr, sessionId: 's1' });
    registry.apply(lifecycle('opened', sha1));
    expect(registry.getRoute(pr)?.headSource).toBe('lifecycle');

    expect(registry.register({ prRef: pr, sessionId: 's1', headSha: sha3 })).toMatchObject({
      ignoredHeadSha: sha3,
      route: { headSha: sha1 },
    });
    expect(registry.register({ prRef: pr, sessionId: 's1', headSha: sha3, replace: true })).toMatchObject({
      ignoredHeadSha: null,
      route: { headSha: sha3 },
    });
  });

  it('still lets a registration correct a head it asserted itself', () => {
    registry.register({ prRef: pr, sessionId: 's1', headSha: sha1 });
    expect(registry.register({ prRef: pr, sessionId: 's1', headSha: sha2 })).toMatchObject({
      ignoredHeadSha: null,
      route: { headSha: sha2, headSource: 'registration' },
    });
  });
});

describe('an unknown head', () => {
  it('suppresses positive signals, because no head can be vouched for', () => {
    registry.register({ prRef: pr, sessionId: 's1' });
    for (const positive of [ciGreen(sha1), allGreen(sha1), temployReady(sha1)]) {
      expect(registry.classify(positive)).toMatchObject({
        routed: true,
        stale: false,
        headKnown: false,
        suppressedPositiveSignal: true,
      });
    }
    expect(registry.classify(comment(sha1))).toMatchObject({ suppressedPositiveSignal: false });

    registry.apply(lifecycle('synchronize', sha1));
    expect(registry.classify(ciGreen(sha1))).toMatchObject({ headKnown: true, suppressedPositiveSignal: false });
  });
});

describe('registration backfill', () => {
  // A worker almost always joins a PR that already has CI results and comments. Without
  // this the session is blind to the state it just joined.
  function unroutedCheck(prRef: PrRef, headSha: string, conclusion: string): void {
    db.recordUnrouted({
      deliveryId: `d-${conclusion}-${headSha.slice(0, 4)}`,
      prRef,
      receivedAtIso: '2026-09-08T10:00:00.000Z',
      reason: 'no_route',
      payload: {
        kind: 'ci_check',
        prRef,
        headSha,
        actorLogin: null,
        occurredAtIso: '2026-09-08T10:00:00.000Z',
        htmlUrl: null,
        checkName: 'ci/test',
        checkRunId: 1,
        state: { status: 'completed', conclusion },
        detailsUrl: null,
      },
    } as never);
  }

  it('replays events that arrived before the session registered', () => {
    const head = 'a'.repeat(40);
    unroutedCheck(pr, head, 'failure');

    const result = new PrRegistry(db).register({ prRef: pr, sessionId: 's1', headSha: head });

    expect(result.ok && result.backfilled).toBe(1);
    expect(db.countPending('s1')).toBe(1);
  });

  it('flags a backfilled event for a superseded head as stale', () => {
    unroutedCheck(pr, 'b'.repeat(40), 'success');

    new PrRegistry(db).register({ prRef: pr, sessionId: 's1', headSha: 'c'.repeat(40) });

    const [event] = db.leaseEvents('s1', { leaseMs: 60_000, limit: 10, now: Date.now() });
    expect(event?.stale).toBe(true);
  });

  it('does not replay the same event to a later registration', () => {
    unroutedCheck(pr, 'a'.repeat(40), 'failure');
    new PrRegistry(db).register({ prRef: pr, sessionId: 's1', headSha: 'a'.repeat(40) });

    const second = new PrRegistry(db).register({
      prRef: pr, sessionId: 's2', headSha: 'a'.repeat(40), replace: true,
    });

    expect(second.ok && second.backfilled).toBe(0);
  });
});
