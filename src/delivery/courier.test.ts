import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionQueue } from '../channel/queue.js';
import { PrRegistry } from '../registry/registry.js';
import { ChannelDb, newEventId } from '../store/db.js';
import type { EnvelopeOf, PrRef } from '../types.js';
import { untrusted } from '../types.js';
import { SessionCourier } from './courier.js';
import { CourierService } from './service.js';

const pr: PrRef = { repo: 'acme-labs/widget-service', prNumber: 42 };
let dir: string;
let db: ChannelDb;

function comment(sessionId: string, text: string): EnvelopeOf<'pr_comment'> {
  return {
    id: newEventId(),
    deliveryId: `d-${text}`,
    prRef: pr,
    sessionId,
    receivedAtIso: '2026-09-08T10:00:00.000Z',
    headSha: null,
    stale: false,
    kind: 'pr_comment',
    payload: {
      kind: 'pr_comment',
      prRef: pr,
      headSha: null,
      actorLogin: 'sam-reviewer',
      occurredAtIso: '2026-09-08T10:00:00.000Z',
      htmlUrl: null,
      action: 'created',
      commentId: 1,
      untrustedBody: untrusted(text),
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'courier-'));
  db = ChannelDb.open(join(dir, 'test.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SessionCourier', () => {
  const target = { sessionId: 's1', workerDir: '/checkout' };

  it('pushes queued events into the session and acks them', async () => {
    db.enqueueEvent(comment('s1', 'first'));
    db.enqueueEvent(comment('s1', 'second'));
    const send = vi.fn().mockResolvedValue(undefined);

    const result = await new SessionCourier(
      new SessionQueue(db, 's1', { leaseMs: 60_000 }),
      target,
      send,
    ).deliverPending();

    expect(result.delivered).toHaveLength(2);
    expect(result.stoppedAt).toBeNull();
    expect(db.countPending('s1')).toBe(0);
    expect(send.mock.calls[0]?.[0]).toEqual(target);
    expect(send.mock.calls[0]?.[1]).toContain('first');
  });

  it('leaves a failed event unacked so its lease redelivers it', async () => {
    db.enqueueEvent(comment('s1', 'only'));
    const send = vi.fn().mockRejectedValue(new Error('claude exited 1'));

    const result = await new SessionCourier(
      new SessionQueue(db, 's1', { leaseMs: 60_000 }),
      target,
      send,
    ).deliverPending();

    expect(result.delivered).toHaveLength(0);
    expect(result.stoppedAt).not.toBeNull();
    expect(db.countPending('s1')).toBe(1);
  });

  it('stops at the first failure so later events cannot overtake it', async () => {
    db.enqueueEvent(comment('s1', 'first'));
    db.enqueueEvent(comment('s1', 'second'));
    const send = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);

    const result = await new SessionCourier(
      new SessionQueue(db, 's1', { leaseMs: 60_000 }),
      target,
      send,
    ).deliverPending();

    expect(result.delivered).toHaveLength(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.countPending('s1')).toBe(2);
  });
});

describe('CourierService', () => {
  it('delivers each route to its own session in its own checkout', async () => {
    new PrRegistry(db).register({ prRef: pr, sessionId: 's1', workerDir: '/checkout/widget' });
    db.enqueueEvent(comment('s1', 'hello'));
    const send = vi.fn().mockResolvedValue(undefined);

    const summary = await new CourierService({ db, send, leaseMs: 60_000 }).drainOnce();

    expect(summary).toEqual({ sessions: 1, delivered: 1, stalled: 0 });
    expect(send.mock.calls[0]?.[0]).toEqual({ sessionId: 's1', workerDir: '/checkout/widget' });
  });

  it('does not deliver to a closed route', async () => {
    const registry = new PrRegistry(db);
    registry.register({ prRef: pr, sessionId: 's1', workerDir: '/checkout/widget' });
    db.enqueueEvent(comment('s1', 'hello'));
    db.closeRoute(pr);
    const send = vi.fn().mockResolvedValue(undefined);

    const summary = await new CourierService({ db, send, leaseMs: 60_000 }).drainOnce();

    expect(summary.sessions).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
