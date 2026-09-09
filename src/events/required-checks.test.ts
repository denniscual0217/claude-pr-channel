import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelDb, newEventId } from '../store/db.js';
import type { CiAllRequiredGreenEvent, EventEnvelope, PrEvent, PrRef } from '../types.js';
import { normalizeWebhook } from './normalize.js';
import { RequiredChecksTracker } from './required-checks.js';

const repository = { full_name: 'Toptal/Example' };
const sender = { login: 'octocat' };
const pr: PrRef = { repo: 'toptal/example', prNumber: 42 };
const head = 'a'.repeat(40);
const olderHead = 'b'.repeat(40);
const session = 'worker-1';

function checkRun(name: string, conclusion: string, headSha: string, completedAt: string): Record<string, unknown> {
  return {
    action: conclusion === 'rerequested' ? 'rerequested' : 'completed',
    repository,
    sender,
    check_run: {
      id: 9001,
      name,
      head_sha: headSha,
      status: 'completed',
      conclusion: conclusion === 'rerequested' ? 'success' : conclusion,
      completed_at: completedAt,
      pull_requests: [{ number: 42 }],
    },
  };
}

function ciEvent(checkName: string, conclusion: string, headSha = head, completedAt = '2026-09-07T10:05:00Z'): PrEvent {
  return normalizeWebhook('check_run', checkRun(checkName, conclusion, headSha, completedAt))!;
}

function synchronize(headSha: string): PrEvent {
  return normalizeWebhook('pull_request', {
    action: 'synchronize',
    repository,
    sender,
    pull_request: {
      number: 42,
      title: 'Add the thing',
      draft: false,
      updated_at: '2026-09-07T10:00:00Z',
      head: { sha: headSha, ref: 'feature/thing' },
      base: { ref: 'main' },
    },
  })!;
}

// What the dispatcher would have queued for the session holding the route.
function queueGreen(green: CiAllRequiredGreenEvent): EventEnvelope {
  const envelope: EventEnvelope = {
    id: newEventId(),
    deliveryId: `d-${newEventId()}`,
    prRef: green.prRef,
    sessionId: session,
    receivedAtIso: green.occurredAtIso,
    headSha: green.headSha,
    stale: true,
    kind: 'ci_all_required_green',
    payload: green,
  };
  db.enqueueEvent(envelope, 1_000);
  return envelope;
}

let dir: string;
let dbPath: string;
let db: ChannelDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pr-channel-checks-'));
  dbPath = join(dir, 'channel.db');
  db = ChannelDb.open(dbPath);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed by the test
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('RequiredChecksTracker', () => {
  it('announces all-required-green exactly once when every required check succeeds', () => {
    const tracker = new RequiredChecksTracker(db, ['lint', 'test']);
    expect(tracker.observe(ciEvent('lint', 'success'), head)).toBeNull();
    expect(tracker.observe(ciEvent('docs', 'success'), head)).toBeNull();
    const green = tracker.observe(ciEvent('test', 'success'), head);
    expect(green).toMatchObject({
      kind: 'ci_all_required_green',
      prRef: pr,
      headSha: head,
      checkNames: ['lint', 'test'],
    });
    expect(tracker.observe(ciEvent('test', 'success'), head)).toBeNull();
  });

  it('is not green while any required check is missing, failed or re-queued', () => {
    const tracker = new RequiredChecksTracker(db, ['lint', 'test']);
    expect(tracker.observe(ciEvent('lint', 'success'), head)).toBeNull();
    expect(tracker.observe(ciEvent('test', 'failure'), head)).toBeNull();
    expect(tracker.observe(ciEvent('test', 'success'), head)).not.toBeNull();
    expect(tracker.observe(ciEvent('test', 'rerequested'), head)).toBeNull();
    expect(tracker.observe(ciEvent('test', 'success'), head)).not.toBeNull();
  });

  it('tracks each head separately so an old head cannot make a new head green', () => {
    const tracker = new RequiredChecksTracker(db, ['lint', 'test']);
    expect(tracker.observe(ciEvent('lint', 'success', olderHead), head)).toBeNull();
    expect(tracker.observe(ciEvent('lint', 'success', head), head)).toBeNull();
    expect(tracker.observe(ciEvent('test', 'success', olderHead), head)).toMatchObject({ headSha: olderHead });
    expect(tracker.states(pr, head).size).toBe(1);
    expect(tracker.observe(ciEvent('test', 'success', head), head)).toMatchObject({ headSha: head });
  });

  it('never announces without a configured required list', () => {
    const tracker = new RequiredChecksTracker(db, []);
    expect(tracker.observe(ciEvent('lint', 'success'), head)).toBeNull();
  });

  it('forgets every head of a PR once it closes', () => {
    const tracker = new RequiredChecksTracker(db, ['lint']);
    tracker.observe(ciEvent('lint', 'failure', olderHead), olderHead);
    tracker.observe(ciEvent('lint', 'success', head), head);
    tracker.forget(pr);
    expect(tracker.states(pr, head).size).toBe(0);
    expect(tracker.states(pr, olderHead).size).toBe(0);
  });

  it("keeps the current head's checks when a lifecycle event for another head is refused", () => {
    const tracker = new RequiredChecksTracker(db, ['lint', 'test']);
    tracker.observe(ciEvent('lint', 'success', head), head);

    // The registry refused this out-of-order synchronize, so the head is still `head`.
    expect(tracker.observe(synchronize(olderHead), head)).toBeNull();

    expect(tracker.states(pr, head).size).toBe(1);
    expect(tracker.observe(ciEvent('test', 'success', head), head)).toMatchObject({ headSha: head });
  });

  it('keeps checks banked for a head the registry has not reached yet', () => {
    const tracker = new RequiredChecksTracker(db, ['lint', 'test']);
    tracker.observe(ciEvent('lint', 'success', head), olderHead);

    // A lifecycle delivery carrying the head still in force says nothing about `head`.
    expect(tracker.observe(synchronize(olderHead), olderHead)).toBeNull();

    expect(tracker.states(pr, head).size).toBe(1);
    expect(tracker.observe(ciEvent('test', 'success', head), head)).toMatchObject({ headSha: head });
  });

  it('drops nothing while the route has no head at all', () => {
    const tracker = new RequiredChecksTracker(db, ['lint', 'test']);
    tracker.observe(ciEvent('lint', 'success', head), null);
    expect(tracker.observe(synchronize(head), null)).toBeNull();
    expect(tracker.observe(ciEvent('test', 'success', head), null)).toMatchObject({ headSha: head });
  });

  it('completes a set that a restart interrupted', () => {
    new RequiredChecksTracker(db, ['lint', 'test']).observe(ciEvent('lint', 'success'), head);
    db.close();

    db = ChannelDb.open(dbPath);
    const afterRestart = new RequiredChecksTracker(db, ['lint', 'test']);
    expect(afterRestart.observe(ciEvent('test', 'success'), head)).toMatchObject({ headSha: head });
  });

  it('announces a head that was already green once it becomes the current head', () => {
    const unconfigured = new RequiredChecksTracker(db, []);
    unconfigured.observe(ciEvent('lint', 'success', head), olderHead);
    unconfigured.observe(ciEvent('test', 'success', head), olderHead);

    const configured = new RequiredChecksTracker(db, ['lint', 'test']);
    expect(configured.observe(synchronize(head), head)).toMatchObject({
      kind: 'ci_all_required_green',
      headSha: head,
    });
    expect(configured.observe(synchronize(head), head)).toBeNull();
  });

  it('re-announces a head whose green was suppressed, once that head becomes current', () => {
    const tracker = new RequiredChecksTracker(db, ['lint', 'test']);
    tracker.observe(ciEvent('lint', 'success', head), null);
    // No head on record, so this green reaches the session as history only.
    expect(tracker.observe(ciEvent('test', 'success', head), null)).toMatchObject({ headSha: head });

    expect(tracker.observe(synchronize(head), head)).toMatchObject({
      kind: 'ci_all_required_green',
      headSha: head,
    });
    expect(tracker.observe(synchronize(head), head)).toBeNull();
  });

  it('does not duplicate a suppressed green that is still waiting in the queue', () => {
    db.upsertRoute({ prRef: pr, sessionId: session, headSha: olderHead });
    const tracker = new RequiredChecksTracker(db, ['lint', 'test']);
    tracker.observe(ciEvent('lint', 'success', head), olderHead);
    queueGreen(tracker.observe(ciEvent('test', 'success', head), olderHead)!);

    // Staleness is re-evaluated at poll time, so that copy is itself the announcement.
    expect(tracker.observe(synchronize(head), head)).toBeNull();
  });

  it('re-announces a suppressed green the session has already been handed', () => {
    db.upsertRoute({ prRef: pr, sessionId: session, headSha: olderHead });
    const tracker = new RequiredChecksTracker(db, ['lint', 'test']);
    tracker.observe(ciEvent('lint', 'success', head), olderHead);
    queueGreen(tracker.observe(ciEvent('test', 'success', head), olderHead)!);
    db.leaseEvents(session, { leaseMs: 60_000, now: 1_001 });

    // The session is handling that copy as history and will ack it, so no redelivery can
    // turn it into the green light the head now deserves.
    expect(tracker.observe(synchronize(head), head)).toMatchObject({
      kind: 'ci_all_required_green',
      headSha: head,
    });
    expect(tracker.observe(synchronize(head), head)).toBeNull();
  });

  it('keeps a newer failure when an older success is redelivered', () => {
    const tracker = new RequiredChecksTracker(db, ['lint', 'test']);
    tracker.observe(ciEvent('lint', 'success'), head);
    expect(tracker.observe(ciEvent('test', 'success'), head)).not.toBeNull();
    expect(tracker.observe(ciEvent('test', 'failure', head, '2026-09-07T10:10:00Z'), head)).toBeNull();

    // GitHub redelivers the earlier success: newest on the wire, oldest in fact.
    expect(tracker.observe(ciEvent('test', 'success', head, '2026-09-07T10:05:00Z'), head)).toBeNull();
    expect(tracker.states(pr, head).get('test')).toEqual({ status: 'completed', conclusion: 'failure' });
  });

  it('bounds the heads it keeps per PR, oldest first', () => {
    const tracker = new RequiredChecksTracker(db, ['lint'], { maxTrackedHeadsPerPr: 2 });
    const heads = ['1', '2', '3'].map((digit) => digit.repeat(40));
    for (const headSha of heads) tracker.observe(ciEvent('lint', 'failure', headSha), headSha);

    // The prune walks check_heads and takes the states of whatever it drops with it.
    expect(tracker.states(pr, heads[0]!).size).toBe(0);
    expect(tracker.states(pr, heads[1]!).size).toBe(1);
    expect(tracker.states(pr, heads[2]!).size).toBe(1);
  });
});
