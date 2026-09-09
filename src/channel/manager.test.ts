import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../config.js';
import { ChannelDb, newEventId } from '../store/db.js';
import type { EnvelopeOf, PrLifecycleAction, PrRef } from '../types.js';
import { untrusted } from '../types.js';
import { ChannelManager, SESSION_ID_ENV, channelProcessOptions, watchClientDisconnect } from './manager.js';
import { SessionQueue } from './queue.js';

const pr: PrRef = { repo: 'toptal/example', prNumber: 12 };
const T0 = 1_757_240_000_000;

function lifecycle(sessionId: string, action: PrLifecycleAction): EnvelopeOf<'pr_lifecycle'> {
  return {
    id: newEventId(),
    deliveryId: `d-${action}`,
    prRef: pr,
    sessionId,
    receivedAtIso: new Date(T0).toISOString(),
    headSha: 'head-1',
    stale: false,
    kind: 'pr_lifecycle',
    payload: {
      kind: 'pr_lifecycle',
      prRef: pr,
      headSha: 'head-1',
      actorLogin: 'author',
      occurredAtIso: new Date(T0).toISOString(),
      htmlUrl: null,
      action,
      draft: false,
      baseRef: 'main',
      headRef: 'feature',
      untrustedTitle: untrusted('Title from GitHub'),
    },
  };
}

let db: ChannelDb;
let manager: ChannelManager;

beforeEach(() => {
  db = ChannelDb.open(':memory:');
  manager = new ChannelManager(db);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe('registration', () => {
  it('registers a route and reports the channel active', () => {
    expect(manager.status('sess-1').state).toBe('unregistered');
    const route = manager.register({ prRef: pr, sessionId: 'sess-1', headSha: 'head-1' });
    expect(route).toMatchObject({ prRef: pr, sessionId: 'sess-1', headSha: 'head-1', closed: false });
    expect(manager.status('sess-1')).toMatchObject({ state: 'active', route, unacked: 0, drained: false });
  });

  it('validates its inputs', () => {
    expect(() => manager.register({ prRef: pr, sessionId: ' ' })).toThrow(TypeError);
    expect(() => manager.register({ prRef: { repo: 'Toptal/Example', prNumber: 1 }, sessionId: 's' })).toThrow(TypeError);
    expect(() => manager.register({ prRef: { repo: 'toptal/example', prNumber: 0 }, sessionId: 's' })).toThrow(TypeError);
  });

  it('lets only the owning session deregister', () => {
    manager.register({ prRef: pr, sessionId: 'sess-1' });
    expect(manager.deregister(pr, 'sess-2')).toBe(false);
    expect(manager.status('sess-1').state).toBe('active');
    expect(manager.deregister(pr, 'sess-1')).toBe(true);
    expect(manager.status('sess-1')).toMatchObject({ state: 'closed', drained: true });
    expect(db.findOpenRoute(pr)).toBeNull();
  });
});

describe('deliverTerminalAndClose', () => {
  it('delivers the terminal event first, then closes the route', () => {
    manager.register({ prRef: pr, sessionId: 'sess-1' });
    const queue = new SessionQueue(db, 'sess-1', { leaseMs: 1_000, now: () => T0 });
    const merged = lifecycle('sess-1', 'merged');

    expect(manager.deliverTerminalAndClose(merged, T0)).toEqual({ delivered: true, closed: true });

    const status = manager.status('sess-1', T0);
    expect(status).toMatchObject({ state: 'closed', unacked: 1, drained: false });
    expect(status.route).toMatchObject({ closed: true, lifecycle: 'merged' });
    expect(db.findOpenRoute(pr)).toBeNull();

    const { events } = queue.poll();
    expect(events.map((e) => e.id)).toEqual([merged.id]);
    expect(queue.ack([merged.id]).status).toBe('ok');
    expect(manager.isDrained('sess-1')).toBe(true);
  });

  it('keeps earlier events ahead of the terminal one', () => {
    manager.register({ prRef: pr, sessionId: 'sess-1' });
    const opened = lifecycle('sess-1', 'opened');
    db.enqueueEvent(opened, T0 - 5);
    const closed = lifecycle('sess-1', 'closed');
    manager.deliverTerminalAndClose(closed, T0);

    const queue = new SessionQueue(db, 'sess-1', { leaseMs: 1_000, now: () => T0 });
    expect(queue.poll().events.map((e) => (e.kind === 'pr_lifecycle' ? e.payload.action : e.kind))).toEqual([
      'opened',
      'closed',
    ]);
  });

  it('refuses a non-terminal action', () => {
    manager.register({ prRef: pr, sessionId: 'sess-1' });
    expect(() => manager.deliverTerminalAndClose(lifecycle('sess-1', 'synchronize'))).toThrow(TypeError);
    expect(manager.status('sess-1').state).toBe('active');
  });

  it('does not enqueue or close when the route belongs to another session', () => {
    manager.register({ prRef: pr, sessionId: 'sess-1' });
    expect(manager.deliverTerminalAndClose(lifecycle('sess-2', 'closed'))).toEqual({
      delivered: false,
      reason: 'session_mismatch',
    });
    expect(manager.status('sess-1').state).toBe('active');
    expect(db.countPending('sess-2')).toBe(0);
  });

  it('reports no_route and route_closed', () => {
    expect(manager.deliverTerminalAndClose(lifecycle('sess-1', 'closed'))).toEqual({
      delivered: false,
      reason: 'no_route',
    });
    manager.register({ prRef: pr, sessionId: 'sess-1' });
    manager.deliverTerminalAndClose(lifecycle('sess-1', 'closed'));
    expect(manager.deliverTerminalAndClose(lifecycle('sess-1', 'merged'))).toEqual({
      delivered: false,
      reason: 'route_closed',
    });
    expect(db.countPending('sess-1')).toBe(1);
  });
});

describe('watchForDrain', () => {
  it('fires once the route is closed and every event is acked', () => {
    vi.useFakeTimers();
    manager.register({ prRef: pr, sessionId: 'sess-1' });
    const onDrained = vi.fn();
    const stop = manager.watchForDrain('sess-1', { intervalMs: 100, onDrained });

    vi.advanceTimersByTime(500);
    expect(onDrained).not.toHaveBeenCalled();

    const closed = lifecycle('sess-1', 'closed');
    manager.deliverTerminalAndClose(closed, T0);
    vi.advanceTimersByTime(500);
    expect(onDrained).not.toHaveBeenCalled();

    const queue = new SessionQueue(db, 'sess-1', { leaseMs: 1_000, now: () => T0 });
    queue.poll();
    queue.ack([closed.id]);
    vi.advanceTimersByTime(100);
    expect(onDrained).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(onDrained).toHaveBeenCalledTimes(1);
    stop();
  });

  it('can be stopped before it fires', () => {
    vi.useFakeTimers();
    manager.register({ prRef: pr, sessionId: 'sess-1' });
    const onDrained = vi.fn();
    const stop = manager.watchForDrain('sess-1', { intervalMs: 100, onDrained });
    stop();
    manager.deregister(pr, 'sess-1');
    vi.advanceTimersByTime(1_000);
    expect(onDrained).not.toHaveBeenCalled();
  });
});

describe('channelProcessOptions', () => {
  it('reads the session id from the flag or the environment', () => {
    expect(channelProcessOptions(['--session-id', 'abc'], {})).toMatchObject({ sessionId: 'abc', leaseMs: 60_000 });
    expect(channelProcessOptions([], { [SESSION_ID_ENV]: 'from-env' }).sessionId).toBe('from-env');
    expect(channelProcessOptions(['--session-id', 'flag'], { [SESSION_ID_ENV]: 'env' }).sessionId).toBe('flag');
  });

  it('fails without a session id or with a bad lease', () => {
    expect(() => channelProcessOptions([], {})).toThrow(ConfigError);
    expect(() => channelProcessOptions(['--session-id'], {})).toThrow(ConfigError);
    expect(() => channelProcessOptions(['--session-id', '--other'], {})).toThrow(ConfigError);
    expect(() => channelProcessOptions(['--session-id', 'x'], { PR_CHANNEL_LEASE_TIMEOUT_MS: 'soon' })).toThrow(
      ConfigError,
    );
  });

  it('resolves the db path and lease timeout from the environment', () => {
    const options = channelProcessOptions(['--session-id', 'x'], {
      PR_CHANNEL_DB_PATH: '/var/tmp/pr-channel/test.db',
      PR_CHANNEL_LEASE_TIMEOUT_MS: '2500',
    });
    expect(options).toEqual({ sessionId: 'x', dbPath: '/var/tmp/pr-channel/test.db', leaseMs: 2_500 });
  });
});

describe('client disconnect', () => {
  async function drain(stdin: PassThrough): Promise<void> {
    stdin.end();
    stdin.resume();
    await new Promise((resolve) => stdin.once('close', resolve));
  }

  it('exits on stdin EOF, which the stdio transport never reports', async () => {
    const stdin = new PassThrough();
    const onDisconnect = vi.fn();
    watchClientDisconnect(stdin, onDisconnect);

    await drain(stdin);

    expect(onDisconnect).toHaveBeenCalled();
  });

  it('reports the disconnect once even though end and close both fire', async () => {
    const stdin = new PassThrough();
    const onDisconnect = vi.fn();
    watchClientDisconnect(stdin, onDisconnect);

    await drain(stdin);

    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('stops reporting once unwatched', async () => {
    const stdin = new PassThrough();
    const onDisconnect = vi.fn();
    watchClientDisconnect(stdin, onDisconnect)();

    await drain(stdin);

    expect(onDisconnect).not.toHaveBeenCalled();
  });
});

describe('process boundary', () => {
  it('never reaches for tmux, child processes, or signals', () => {
    for (const file of ['manager.ts', 'mcp-server.ts', 'queue.ts', 'bin.ts']) {
      const source = readFileSync(join(import.meta.dirname, file), 'utf8');
      expect(source, file).not.toMatch(/child_process|tmux|process\.kill\b/);
    }
  });
});
