import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelDb, newEventId } from '../store/db.js';
import type { EventEnvelope, PrRef } from '../types.js';
import { untrusted } from '../types.js';
import { DEFAULT_POLL_LIMIT, MAX_POLL_LIMIT, SessionQueue } from './queue.js';

const pr: PrRef = { repo: 'toptal/example', prNumber: 7 };
const T0 = 1_757_240_000_000;
const LEASE_MS = 1_000;

function comment(sessionId: string, commentId: number): EventEnvelope {
  return {
    id: newEventId(),
    deliveryId: `d-${commentId}`,
    prRef: pr,
    sessionId,
    receivedAtIso: new Date(T0).toISOString(),
    headSha: 'head-1',
    stale: false,
    kind: 'pr_comment',
    payload: {
      kind: 'pr_comment',
      prRef: pr,
      headSha: 'head-1',
      actorLogin: 'reviewer',
      occurredAtIso: new Date(T0).toISOString(),
      htmlUrl: null,
      action: 'created',
      commentId,
      untrustedBody: untrusted(`comment ${commentId}`),
    },
  };
}

let db: ChannelDb;
let a: SessionQueue;
let b: SessionQueue;

beforeEach(() => {
  db = ChannelDb.open(':memory:');
  a = new SessionQueue(db, 'session-a', { leaseMs: LEASE_MS, now: () => T0 });
  b = new SessionQueue(db, 'session-b', { leaseMs: LEASE_MS, now: () => T0 });
});

afterEach(() => db.close());

describe('SessionQueue.poll', () => {
  it('returns events in enqueue order and leases them', () => {
    const events = [comment('session-a', 1), comment('session-a', 2), comment('session-a', 3)];
    for (const [i, event] of events.entries()) db.enqueueEvent(event, T0 + i);

    const first = a.poll({ limit: 2 });
    expect(first.events.map((e) => e.id)).toEqual([events[0]!.id, events[1]!.id]);
    expect(first.leaseUntil).toBe(T0 + LEASE_MS);

    const rest = a.poll();
    expect(rest.events.map((e) => e.id)).toEqual([events[2]!.id]);
    expect(a.poll().events).toEqual([]);
    expect(a.stats()).toEqual({ pending: 0, leased: 3, acked: 0 });
  });

  it('never returns another session\'s events', () => {
    const mine = comment('session-a', 1);
    const theirs = comment('session-b', 2);
    db.enqueueEvent(theirs, T0);
    db.enqueueEvent(mine, T0 + 1);

    expect(a.poll().events.map((e) => e.id)).toEqual([mine.id]);
    expect(b.poll().events.map((e) => e.id)).toEqual([theirs.id]);
    expect(a.owns(theirs.id)).toBe(false);
  });

  it('makes an unacked event visible again once its lease expires', () => {
    const event = comment('session-a', 1);
    db.enqueueEvent(event, T0);

    expect(a.poll({ now: T0 }).events).toHaveLength(1);
    expect(a.poll({ now: T0 + LEASE_MS - 1 }).events).toHaveLength(0);
    const redelivered = a.poll({ now: T0 + LEASE_MS });
    expect(redelivered.events.map((e) => e.id)).toEqual([event.id]);
    expect(redelivered.leaseUntil).toBe(T0 + 2 * LEASE_MS);
  });

  it('clamps the limit and rejects nonsense', () => {
    for (let i = 0; i < MAX_POLL_LIMIT + 5; i++) db.enqueueEvent(comment('session-a', i), T0 + i);
    expect(a.poll({ limit: MAX_POLL_LIMIT + 50 }).events).toHaveLength(MAX_POLL_LIMIT);
    expect(a.poll().events).toHaveLength(Math.min(5, DEFAULT_POLL_LIMIT));
    expect(() => a.poll({ limit: 0 })).toThrow(RangeError);
    expect(() => a.poll({ limit: 1.5 })).toThrow(RangeError);
  });
});

describe('SessionQueue.ack', () => {
  it('acks delivered events and is idempotent', () => {
    const event = comment('session-a', 1);
    db.enqueueEvent(event, T0);
    a.poll();

    expect(a.ack([event.id, event.id])).toEqual({ status: 'ok', acked: [event.id], alreadyAcked: [] });
    expect(a.ack([event.id])).toEqual({ status: 'ok', acked: [], alreadyAcked: [event.id] });
    expect(a.countUnacked()).toBe(0);
    expect(a.poll({ now: T0 + 10 * LEASE_MS }).events).toEqual([]);
  });

  it('rejects ids that belong to another session and touches nothing', () => {
    const theirs = comment('session-b', 2);
    db.enqueueEvent(theirs, T0);
    b.poll();

    expect(a.ack([theirs.id])).toEqual({ status: 'rejected', rejected: [theirs.id] });
    expect(db.countPending('session-b')).toBe(1);
    expect(b.ack([theirs.id])).toEqual({ status: 'ok', acked: [theirs.id], alreadyAcked: [] });
  });

  it('rejects the whole batch when any id is foreign or unknown', () => {
    const mine = comment('session-a', 1);
    db.enqueueEvent(mine, T0);
    a.poll();

    expect(a.ack([mine.id, 'not-an-event'])).toEqual({ status: 'rejected', rejected: ['not-an-event'] });
    expect(db.countPending('session-a')).toBe(1);
  });

  it('rejects an id that was enqueued for this session but never polled', () => {
    const mine = comment('session-a', 1);
    db.enqueueEvent(mine, T0);
    expect(a.ack([mine.id])).toEqual({ status: 'rejected', rejected: [mine.id] });
  });

  it('still owns an event after its lease expired and it was redelivered', () => {
    const event = comment('session-a', 1);
    db.enqueueEvent(event, T0);
    a.poll({ now: T0 });
    a.poll({ now: T0 + LEASE_MS });
    expect(a.ack([event.id], T0 + LEASE_MS + 1)).toEqual({ status: 'ok', acked: [event.id], alreadyAcked: [] });
  });
});

describe('SessionQueue construction', () => {
  it('refuses an empty session id or a non-positive lease', () => {
    expect(() => new SessionQueue(db, '', { leaseMs: LEASE_MS })).toThrow(TypeError);
    expect(() => new SessionQueue(db, 'x', { leaseMs: 0 })).toThrow(TypeError);
  });
});
