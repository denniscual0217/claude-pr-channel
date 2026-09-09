import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebhookSecret } from './config.js';
import { createDispatcher, type Dispatcher, type DispatcherLogEntry } from './dispatcher.js';
import { ChannelDb } from './store/db.js';
import type { EventEnvelope, GithubEventName, PrRef } from './types.js';
import type { WebhookHeaders } from './webhook/server.js';

const REPO = 'acme-labs/widget-service';
const PR: PrRef = { repo: REPO, prNumber: 42 };
const SESSION = 'session-alpha';
const SHA_1 = 'a'.repeat(40);
const SHA_2 = 'b'.repeat(40);
const BODY_SENTINEL = 'zz-untrusted-body-marker-zz';
const FAKE_SECRET = 'test-only-fake-secret';
const CLOCK = new Date('2026-09-07T09:00:00.000Z');

let db: ChannelDb;
let dispatcher: Dispatcher;
let logs: DispatcherLogEntry[];
let deliveryCounter = 0;

function headers(eventName: GithubEventName, deliveryId = `delivery-${(deliveryCounter += 1)}`): WebhookHeaders {
  return { eventName, deliveryId, repo: REPO };
}

function repository() {
  return { full_name: 'Acme-Labs/Widget-Service' };
}

function commentPayload(body: string, commentId = 1) {
  return {
    action: 'created',
    repository: repository(),
    issue: { number: PR.prNumber, pull_request: { url: 'https://api.github.com/pulls/42' } },
    comment: { id: commentId, body, user: { login: 'reviewer' }, created_at: '2026-09-07T10:00:00Z' },
    sender: { login: 'reviewer' },
  };
}

function checkRunPayload(
  name: string,
  headSha: string,
  conclusion: string,
  id = 500,
  overrides: Record<string, unknown> = {},
) {
  return {
    action: 'completed',
    repository: repository(),
    check_run: {
      id,
      name,
      head_sha: headSha,
      status: 'completed',
      conclusion,
      completed_at: '2026-09-07T10:05:00Z',
      pull_requests: [{ number: PR.prNumber }],
      ...overrides,
    },
  };
}

function lifecyclePayload(action: string, headSha: string, extra: Record<string, unknown> = {}) {
  return {
    action,
    repository: repository(),
    pull_request: {
      number: PR.prNumber,
      draft: false,
      title: BODY_SENTINEL,
      html_url: 'https://github.com/acme-labs/widget-service/pull/42',
      updated_at: '2026-09-07T10:10:00Z',
      head: { sha: headSha, ref: 'feature/widget' },
      base: { ref: 'main' },
      ...extra,
    },
    sender: { login: 'author' },
  };
}

function queued(sessionId = SESSION): EventEnvelope[] {
  return db.leaseEvents(sessionId, { leaseMs: 1_000, limit: 100, now: 0 });
}

function dispatcherOver(target: ChannelDb, requiredChecks: readonly string[] = ['ci/lint', 'ci/test']): Dispatcher {
  return createDispatcher({
    db: target,
    config: {
      host: '127.0.0.1',
      port: 0,
      maxPayloadBytes: 65_536,
      repoAllowlist: new Set([REPO]),
      rateLimit: { maxDeliveries: 100, windowMs: 60_000 },
      requiredChecks: [...requiredChecks],
  commentAuthors: null,
    },
    verifier: new WebhookSecret(FAKE_SECRET),
    logger: (entry) => logs.push(entry),
    // Fixed, so every route this suite registers is stamped with one known instant.
    now: () => CLOCK,
  });
}

beforeEach(() => {
  db = ChannelDb.open(':memory:');
  logs = [];
  dispatcher = dispatcherOver(db);
  dispatcher.registry.register({ prRef: PR, sessionId: SESSION, headSha: SHA_1 });
});

afterEach(() => {
  db.close();
});

describe('routing', () => {
  it('delivers a PR comment to the one registered session', () => {
    const result = dispatcher.handleDelivery(headers('issue_comment'), commentPayload(BODY_SENTINEL));

    expect(result.outcome).toBe('dispatched');
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ kind: 'pr_comment', outcome: 'enqueued', sessionId: SESSION });

    const events = queued();
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ kind: 'pr_comment', untrustedBody: { untrusted: true, text: BODY_SENTINEL } });
  });

  it('records an event for an unregistered PR as unrouted and queues nothing', () => {
    dispatcher.registry.deregister(PR, SESSION);

    const result = dispatcher.handleDelivery(headers('issue_comment'), commentPayload('hello'));

    expect(result.events[0]).toMatchObject({ outcome: 'unrouted', reason: 'no_route' });
    expect(queued()).toHaveLength(0);
    expect(db.countUnrouted(PR)).toBe(1);
  });

  it('drops a replayed delivery id without enqueueing again', () => {
    const first = headers('issue_comment', 'replayed-delivery');
    dispatcher.handleDelivery(first, commentPayload('hello'));
    const replay = dispatcher.handleDelivery(first, commentPayload('hello'));

    expect(replay.outcome).toBe('replayed_delivery');
    expect(replay.events).toHaveLength(0);
    expect(queued()).toHaveLength(1);
  });

  it('ignores a delivery that carries no PR event', () => {
    const result = dispatcher.handleDelivery(headers('issue_comment'), {
      action: 'created',
      repository: repository(),
      issue: { number: 7 },
      comment: { id: 3, body: 'plain issue' },
    });

    expect(result.outcome).toBe('no_pr_events');
    expect(queued()).toHaveLength(0);
    expect(db.countUnrouted()).toBe(0);
  });
});

describe('head tracking', () => {
  it('flags a green check for a superseded head and suppresses it as a positive signal', () => {
    dispatcher.handleDelivery(headers('pull_request'), lifecyclePayload('synchronize', SHA_2));
    expect(dispatcher.registry.currentHead(PR)).toBe(SHA_2);

    const stale = dispatcher.handleDelivery(headers('check_run'), checkRunPayload('ci/test', SHA_1, 'success'));
    expect(stale.events[0]).toMatchObject({ stale: true, suppressedPositiveSignal: true });

    const fresh = dispatcher.handleDelivery(headers('check_run'), checkRunPayload('ci/test', SHA_2, 'success', 501));
    expect(fresh.events[0]).toMatchObject({ stale: false, suppressedPositiveSignal: false });
  });

  it('derives all-required-green once per head from the configured required checks', () => {
    dispatcher.handleDelivery(headers('check_run'), checkRunPayload('ci/lint', SHA_1, 'success', 601));
    const second = dispatcher.handleDelivery(headers('check_run'), checkRunPayload('ci/test', SHA_1, 'success', 602));

    expect(second.events.map((event) => event.kind)).toEqual(['ci_check', 'ci_all_required_green']);
    expect(second.events[1]).toMatchObject({ derived: true, outcome: 'enqueued', stale: false });

    const again = dispatcher.handleDelivery(headers('check_run'), checkRunPayload('ci/test', SHA_1, 'success', 603));
    expect(again.events.map((event) => event.kind)).toEqual(['ci_check']);
  });

  it('re-derives all-required-green separately for a new head', () => {
    dispatcher.handleDelivery(headers('check_run'), checkRunPayload('ci/lint', SHA_1, 'success', 701));
    dispatcher.handleDelivery(headers('check_run'), checkRunPayload('ci/test', SHA_1, 'success', 702));
    dispatcher.handleDelivery(headers('pull_request'), lifecyclePayload('synchronize', SHA_2));
    dispatcher.handleDelivery(headers('check_run'), checkRunPayload('ci/lint', SHA_2, 'success', 703));
    const complete = dispatcher.handleDelivery(headers('check_run'), checkRunPayload('ci/test', SHA_2, 'success', 704));

    const green = complete.events.find((event) => event.kind === 'ci_all_required_green');
    expect(green).toMatchObject({ derived: true, stale: false });
    const envelopes = queued().filter((envelope) => envelope.kind === 'ci_all_required_green');
    expect(envelopes.map((envelope) => envelope.headSha)).toEqual([SHA_1, SHA_2]);
  });
});

describe('terminal lifecycle', () => {
  it('enqueues the terminal event before closing the route', () => {
    const result = dispatcher.handleDelivery(
      headers('pull_request'),
      lifecyclePayload('closed', SHA_1, { merged: true, merged_at: '2026-09-07T11:00:00Z' }),
    );

    expect(result.events[0]).toMatchObject({ kind: 'pr_lifecycle', terminal: true, outcome: 'enqueued' });
    const events = queued();
    expect(events.at(-1)!.payload).toMatchObject({ kind: 'pr_lifecycle', action: 'merged' });

    const route = dispatcher.registry.getRoute(PR)!;
    expect(route.closed).toBe(true);
    expect(route.lifecycle).toBe('merged');
  });

  it('records later events for a closed route as unrouted', () => {
    dispatcher.handleDelivery(headers('pull_request'), lifecyclePayload('closed', SHA_1));
    const after = dispatcher.handleDelivery(headers('issue_comment'), commentPayload('late comment'));

    expect(after.events[0]).toMatchObject({ outcome: 'unrouted', reason: 'route_closed' });
    expect(db.countUnrouted(PR)).toBe(1);
  });
});

describe('logging', () => {
  it('logs identifiers and states but never untrusted GitHub text', () => {
    dispatcher.handleDelivery(headers('issue_comment'), commentPayload(BODY_SENTINEL));
    dispatcher.handleDelivery(headers('pull_request'), lifecyclePayload('synchronize', SHA_2));

    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(BODY_SENTINEL);
    expect(serialized).toContain(SESSION);
    expect(logs.map((entry) => entry.outcome)).toContain('enqueued');
    expect(logs.every((entry) => entry.component === 'dispatcher')).toBe(true);
  });

  it('reports a logical repeat under a fresh delivery id without dropping it', () => {
    dispatcher.handleDelivery(headers('issue_comment', 'delivery-x'), commentPayload('same text', 9));
    dispatcher.handleDelivery(headers('issue_comment', 'delivery-y'), commentPayload('same text', 9));

    expect(queued()).toHaveLength(2);
    expect(logs.at(-1)?.duplicateOfDeliveryId).toBe('delivery-x');
  });
});

describe('a delivery that fails part-way', () => {
  interface FlakyDispatcher {
    readonly dispatcher: Dispatcher;
    readonly breakEnqueueAfter: (calls: number) => void;
    readonly heal: () => void;
  }

  // The dispatcher shares this suite's db; only enqueueEvent is intercepted, so the
  // rollback it forces is a real SQLite rollback of the whole delivery transaction.
  function flakyDispatcher(): FlakyDispatcher {
    let failAfter: number | null = null;
    let calls = 0;
    const flaky = new Proxy(db, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property !== 'enqueueEvent') return typeof value === 'function' ? value.bind(target) : value;
        return (...args: unknown[]) => {
          calls += 1;
          if (failAfter !== null && calls > failAfter) throw new Error('SQLITE_BUSY: database is locked');
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as ChannelDb;

    return {
      dispatcher: dispatcherOver(flaky),
      breakEnqueueAfter: (allowed: number) => {
        failAfter = allowed;
        calls = 0;
      },
      heal: () => {
        failAfter = null;
      },
    };
  }

  it('does not keep the delivery id, so GitHub\'s redelivery is processed and not dropped', () => {
    const flaky = flakyDispatcher();
    const delivery = headers('issue_comment', 'redelivered-after-failure');
    flaky.breakEnqueueAfter(0);

    expect(() => flaky.dispatcher.handleDelivery(delivery, commentPayload('a review comment'))).toThrow();
    expect(db.hasDelivery('redelivered-after-failure')).toBe(false);
    expect(db.countPending(SESSION)).toBe(0);
    expect(logs.some((logEntry) => logEntry.outcome === 'delivery_failed')).toBe(true);
    expect(logs.some((logEntry) => logEntry.outcome === 'enqueued')).toBe(false);

    flaky.heal();
    const redelivery = flaky.dispatcher.handleDelivery(delivery, commentPayload('a review comment'));
    expect(redelivery.outcome).toBe('dispatched');
    expect(queued()).toHaveLength(1);
  });

  it('rolls the derived all-required-green back with it, so the redelivery re-derives it', () => {
    const flaky = flakyDispatcher();
    flaky.dispatcher.handleDelivery(headers('check_run'), checkRunPayload('ci/lint', SHA_1, 'success', 801));
    const delivery = headers('check_run', 'green-completing-delivery');
    const payload = checkRunPayload('ci/test', SHA_1, 'success', 802);

    // The check enqueues; the all-green derived from it is what fails.
    flaky.breakEnqueueAfter(1);
    expect(() => flaky.dispatcher.handleDelivery(delivery, payload)).toThrow();
    expect(db.hasDelivery('green-completing-delivery')).toBe(false);
    expect(queued().map((envelope) => envelope.kind)).toEqual(['ci_check']);

    flaky.heal();
    const redelivery = flaky.dispatcher.handleDelivery(delivery, payload);
    expect(redelivery.events.map((event) => event.kind)).toEqual(['ci_check', 'ci_all_required_green']);
  });
});

describe('out-of-order lifecycle deliveries', () => {
  it('never rewinds the head, so the superseded head stays superseded', () => {
    dispatcher.handleDelivery(headers('pull_request'), lifecyclePayload('synchronize', SHA_2));
    // The synchronize for the earlier push, delayed in GitHub's delivery queue.
    dispatcher.handleDelivery(
      headers('pull_request'),
      lifecyclePayload('synchronize', SHA_1, { updated_at: '2026-09-07T10:09:00Z' }),
    );

    expect(dispatcher.registry.currentHead(PR)).toBe(SHA_2);
    const late = dispatcher.handleDelivery(headers('check_run'), checkRunPayload('ci/test', SHA_1, 'success', 901));
    expect(late.events[0]).toMatchObject({ stale: true, suppressedPositiveSignal: true });
    const current = dispatcher.handleDelivery(headers('check_run'), checkRunPayload('ci/test', SHA_2, 'success', 902));
    expect(current.events[0]).toMatchObject({ stale: false, suppressedPositiveSignal: false });
  });

  it('does not discard the current head\'s check states when it refuses one', () => {
    dispatcher.handleDelivery(headers('pull_request'), lifecyclePayload('synchronize', SHA_2));
    dispatcher.handleDelivery(headers('check_run'), checkRunPayload('ci/lint', SHA_2, 'success', 910));

    dispatcher.handleDelivery(
      headers('pull_request'),
      lifecyclePayload('synchronize', SHA_1, { updated_at: '2026-09-07T10:09:00Z' }),
    );
    expect(dispatcher.registry.currentHead(PR)).toBe(SHA_2);

    const completing = dispatcher.handleDelivery(headers('check_run'), checkRunPayload('ci/test', SHA_2, 'success', 911));
    expect(completing.events.map((event) => event.kind)).toEqual(['ci_check', 'ci_all_required_green']);
    expect(completing.events[1]).toMatchObject({ stale: false, suppressedPositiveSignal: false });
  });
});

describe('a check state that arrives out of order', () => {
  it('never lets a redelivered older success overwrite a newer failure', () => {
    dispatcher.handleDelivery(headers('check_run'), checkRunPayload('ci/lint', SHA_1, 'success', 1301));
    const complete = dispatcher.handleDelivery(headers('check_run'), checkRunPayload('ci/test', SHA_1, 'success', 1302));
    expect(complete.events.map((event) => event.kind)).toEqual(['ci_check', 'ci_all_required_green']);

    const rerun = { completed_at: '2026-09-07T10:10:00Z' };
    dispatcher.handleDelivery(headers('check_run'), checkRunPayload('ci/test', SHA_1, 'failure', 1303, rerun));

    // The operator redelivers the old success from the webhook UI: newest on the wire,
    // oldest in fact, and under a fresh delivery id the deduper cannot drop.
    const redelivered = dispatcher.handleDelivery(
      headers('check_run'),
      checkRunPayload('ci/test', SHA_1, 'success', 1302),
    );

    expect(redelivered.events.map((event) => event.kind)).toEqual(['ci_check']);
    expect(db.checkStates(PR, SHA_1).get('ci/test')).toEqual({ status: 'completed', conclusion: 'failure' });
    expect(queued().filter((envelope) => envelope.kind === 'ci_all_required_green')).toHaveLength(1);
  });
});

describe('a check delivery that names no pull request', () => {
  const forkRun = { pull_requests: [] };

  it('routes it by a head the PR has held rather than dropping it', () => {
    dispatcher.handleDelivery(headers('pull_request'), lifecyclePayload('synchronize', SHA_2));

    const forked = dispatcher.handleDelivery(
      headers('check_run'),
      checkRunPayload('ci/test', SHA_1, 'failure', 1401, forkRun),
    );

    expect(forked.events).toHaveLength(1);
    expect(forked.events[0]).toMatchObject({ kind: 'ci_check', outcome: 'enqueued', sessionId: SESSION, stale: true });
  });

  it('records it as unrouted once the route is closed', () => {
    dispatcher.handleDelivery(headers('pull_request'), lifecyclePayload('closed', SHA_1));

    const late = dispatcher.handleDelivery(
      headers('check_run'),
      checkRunPayload('ci/test', SHA_1, 'failure', 1402, forkRun),
    );

    expect(late.events[0]).toMatchObject({ outcome: 'unrouted', reason: 'route_closed' });
    expect(db.countUnrouted(PR)).toBe(1);
  });

  it('logs the kind and head of a delivery no route can account for', () => {
    const orphanHead = 'c'.repeat(40);
    const orphan = dispatcher.handleDelivery(
      headers('check_run'),
      checkRunPayload('ci/test', orphanHead, 'failure', 1403, forkRun),
    );

    expect(orphan.outcome).toBe('no_pr_events');
    expect(logs.at(-1)).toMatchObject({
      outcome: 'no_pr_events',
      repo: REPO,
      kind: 'ci_check',
      headSha: orphanHead,
    });
  });
});

describe('an unknown head', () => {
  it('suppresses a green check when nothing has established the PR head', () => {
    dispatcher.registry.deregister(PR, SESSION);
    dispatcher.registry.register({ prRef: PR, sessionId: SESSION });

    const green = dispatcher.handleDelivery(headers('check_run'), checkRunPayload('ci/test', SHA_1, 'success', 950));
    expect(green.events[0]).toMatchObject({ stale: false, suppressedPositiveSignal: true });
  });
});

describe('a check that arrives before the lifecycle delivery for its own head', () => {
  it('survives an out-of-order lifecycle delivery for the head still in force', () => {
    dispatcher.handleDelivery(headers('check_run'), checkRunPayload('ci/lint', SHA_2, 'success', 1101));

    // The ready_for_review the worker triggered just before pushing SHA_2, delayed on
    // the wire: the registry keeps SHA_1, and the checks banked for SHA_2 must survive.
    dispatcher.handleDelivery(
      headers('pull_request'),
      lifecyclePayload('ready_for_review', SHA_1, { updated_at: '2026-09-07T09:59:50Z' }),
    );
    expect(dispatcher.registry.currentHead(PR)).toBe(SHA_1);

    dispatcher.handleDelivery(headers('pull_request'), lifecyclePayload('synchronize', SHA_2));
    expect(dispatcher.registry.currentHead(PR)).toBe(SHA_2);

    const completing = dispatcher.handleDelivery(headers('check_run'), checkRunPayload('ci/test', SHA_2, 'success', 1102));
    expect(completing.events.map((event) => event.kind)).toEqual(['ci_check', 'ci_all_required_green']);
    expect(completing.events[1]).toMatchObject({ stale: false, suppressedPositiveSignal: false });
  });

  it('announces the head to a session already holding the suppressed green', () => {
    dispatcher.handleDelivery(headers('check_run'), checkRunPayload('ci/lint', SHA_2, 'success', 1111));
    dispatcher.handleDelivery(headers('check_run'), checkRunPayload('ci/test', SHA_2, 'success', 1112));

    // The session polls on its own cadence and spends minutes handling what it got --
    // the green among it as history, per the contract -- before it acks anything.
    expect(queued().map((envelope) => envelope.kind)).toEqual(['ci_check', 'ci_check', 'ci_all_required_green']);

    const synchronize = dispatcher.handleDelivery(headers('pull_request'), lifecyclePayload('synchronize', SHA_2));
    expect(synchronize.events.map((event) => event.kind)).toEqual(['pr_lifecycle', 'ci_all_required_green']);
    expect(synchronize.events[1]).toMatchObject({ derived: true, stale: false, suppressedPositiveSignal: false });
  });
});

describe('a registration head from a clone that is behind GitHub', () => {
  it('is corrected by the pull_request delivery that predates the registration', () => {
    // The clone was still on SHA_1 when the worker ran `git rev-parse HEAD`; the push of
    // SHA_2 that GitHub already knows about happened before that.
    dispatcher.handleDelivery(
      headers('pull_request'),
      lifecyclePayload('synchronize', SHA_2, { updated_at: '2026-09-07T08:58:00Z' }),
    );
    expect(dispatcher.registry.currentHead(PR)).toBe(SHA_2);

    // Checks still in flight for the commit the clone had must not read as the PR head.
    dispatcher.handleDelivery(headers('check_run'), checkRunPayload('ci/lint', SHA_1, 'success', 1701));
    const stale = dispatcher.handleDelivery(headers('check_run'), checkRunPayload('ci/test', SHA_1, 'success', 1702));
    expect(stale.events.map((event) => event.kind)).toEqual(['ci_check', 'ci_all_required_green']);
    for (const event of stale.events) {
      expect(event).toMatchObject({ stale: true, suppressedPositiveSignal: true });
    }
  });
});

describe('a dispatcher restart', () => {
  let dir: string;
  let reopened: ChannelDb | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pr-channel-dispatcher-'));
    reopened = null;
  });

  afterEach(() => {
    reopened?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function restart(
    requiredChecks: readonly string[],
    seed: (dispatcher: Dispatcher, target: ChannelDb) => void,
  ): Dispatcher {
    const dbPath = join(dir, 'channel.db');
    const before = ChannelDb.open(dbPath);
    const running = dispatcherOver(before, requiredChecks);
    running.registry.register({ prRef: PR, sessionId: SESSION, headSha: SHA_1 });
    seed(running, before);
    before.close();
    reopened = ChannelDb.open(dbPath);
    return dispatcherOver(reopened);
  }

  it('keeps the greens already banked for the head, so the set still completes', () => {
    const after = restart(['ci/lint', 'ci/test'], (running) => {
      const banked = running.handleDelivery(headers('check_run'), checkRunPayload('ci/lint', SHA_1, 'success', 1001));
      expect(banked.events.map((event) => event.kind)).toEqual(['ci_check']);
    });

    expect(after.registry.currentHead(PR)).toBe(SHA_1);
    const completing = after.handleDelivery(headers('check_run'), checkRunPayload('ci/test', SHA_1, 'success', 1002));
    expect(completing.events.map((event) => event.kind)).toEqual(['ci_check', 'ci_all_required_green']);
    expect(completing.events[1]).toMatchObject({ stale: false, suppressedPositiveSignal: false });
  });

  it('announces a head whose suppressed green the session already acked, once it is current', () => {
    const after = restart(['ci/lint', 'ci/test'], (running, target) => {
      running.handleDelivery(headers('check_run'), checkRunPayload('ci/lint', SHA_2, 'success', 1501));
      running.handleDelivery(headers('check_run'), checkRunPayload('ci/test', SHA_2, 'success', 1502));
      // The worker handled the suppressed green as history and acked it, as the contract
      // tells it to, so poll-time re-evaluation can no longer rescue it.
      for (const envelope of target.leaseEvents(SESSION, { leaseMs: 1_000, limit: 100, now: 0 })) {
        expect(target.ackEvent(envelope.id, 1)).toBe('acked');
      }
    });

    const synchronize = after.handleDelivery(headers('pull_request'), lifecyclePayload('synchronize', SHA_2));

    expect(synchronize.events.map((event) => event.kind)).toEqual(['pr_lifecycle', 'ci_all_required_green']);
    expect(synchronize.events[1]).toMatchObject({ derived: true, stale: false, suppressedPositiveSignal: false });
  });

  it('announces a head whose suppressed green the session polled but has not acked, once it is current', () => {
    const after = restart(['ci/lint', 'ci/test'], (running, target) => {
      running.handleDelivery(headers('check_run'), checkRunPayload('ci/lint', SHA_2, 'success', 1601));
      running.handleDelivery(headers('check_run'), checkRunPayload('ci/test', SHA_2, 'success', 1602));
      // Polled and still being handled when the dispatcher went down: the lease is
      // durable, and the copy the session holds says this head is not current.
      expect(target.leaseEvents(SESSION, { leaseMs: 60_000, limit: 100, now: 0 })).toHaveLength(3);
    });

    const synchronize = after.handleDelivery(headers('pull_request'), lifecyclePayload('synchronize', SHA_2));

    expect(synchronize.events.map((event) => event.kind)).toEqual(['pr_lifecycle', 'ci_all_required_green']);
    expect(synchronize.events[1]).toMatchObject({ derived: true, stale: false, suppressedPositiveSignal: false });
  });

  it('announces a head that was green before the required list was configured, once it is current', () => {
    const after = restart([], (running) => {
      running.handleDelivery(headers('check_run'), checkRunPayload('ci/lint', SHA_2, 'success', 1201));
      running.handleDelivery(headers('check_run'), checkRunPayload('ci/test', SHA_2, 'success', 1202));
    });

    const synchronize = after.handleDelivery(headers('pull_request'), lifecyclePayload('synchronize', SHA_2));
    expect(after.registry.currentHead(PR)).toBe(SHA_2);
    expect(synchronize.events.map((event) => event.kind)).toEqual(['pr_lifecycle', 'ci_all_required_green']);
    expect(synchronize.events[1]).toMatchObject({ derived: true, stale: false, suppressedPositiveSignal: false });
  });
});
