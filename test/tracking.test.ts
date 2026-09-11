import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Tracking, ToolError, type JanitorHandle, type TrackingDeps } from '../src/channel/tracking.js';
import { CONNECT_LINE, type ChildHandle, type SpawnForwarder } from '../src/github/forwarder.js';
import type { DeleteHookResult, GhClient, HookInfo, PrInfo } from '../src/github/gh.js';
import { GhError } from '../src/github/gh.js';
import { readMarkers } from '../src/github/markers.js';
import type { Config } from '../src/config.js';
import type { LogLevel } from '../src/log.js';
import { loadFixture, FIXTURE_REPO, fixtureEvent, type FixtureName } from './fixtures/index.js';
import type { Listener, ListenerOptions } from '../src/webhook/listener.js';

const HEAD = '4d0f1a2b3c4d5e6f70819a2b3c4d5e6f70819a2b';

function config(overrides: Partial<Config> = {}): Config {
  return {
    maxPayloadBytes: 1_048_576,
    rateLimit: { maxDeliveries: 500, windowMs: 60_000 },
    requiredChecks: ['ci/lint', 'ci/test'],
    ciEvents: 'completed',
    commentAuthors: null,
    botComments: 'handle',
    cacheDir: null,
    sweepEnabled: true,
    ...overrides,
  };
}

interface FakeGhClient extends GhClient {
  readonly calls: string[];
  hooks: HookInfo[];
  pinged: number[];
  deleteFailures: Set<number>;
  pr: PrInfo;
  // Hook ids gh "creates" the moment it is spawned.
  createsOnSpawn: number[];
}

function fakeGh(overrides: Partial<PrInfo> = {}): FakeGhClient {
  const calls: string[] = [];
  const client: FakeGhClient = {
    calls,
    hooks: [{ id: 7, active: true, createdAt: '2026-09-01T00:00:00Z' }],
    pinged: [],
    deleteFailures: new Set<number>(),
    createsOnSpawn: [],
    pr: {
      repo: FIXTURE_REPO,
      number: 42,
      headRefOid: HEAD,
      state: 'OPEN',
      isDraft: false,
      url: `https://github.com/${FIXTURE_REPO}/pull/42`,
      headRefName: 'feature/widget-cache',
      baseRefName: 'main',
      ...overrides,
    },
    authLogin: async () => {
      calls.push('authLogin');
      return 'octo-worker';
    },
    extensionInstalled: async () => true,
    prView: async (repo, prNumber) => {
      calls.push(`prView ${repo}#${prNumber}`);
      if (client.pr.state === 'MISSING' as never) throw new GhError('not_a_pr', 'no such pr');
      return client.pr;
    },
    prForCurrentBranch: async () => {
      calls.push('prForCurrentBranch');
      return client.pr;
    },
    listCliHooks: async () => {
      calls.push('listCliHooks');
      return [...client.hooks];
    },
    pingHook: async (_repo, hookId) => {
      calls.push(`pingHook ${hookId}`);
      client.pinged.push(hookId);
    },
    deleteHook: async (_repo, hookId): Promise<DeleteHookResult> => {
      calls.push(`deleteHook ${hookId}`);
      if (client.deleteFailures.has(hookId)) throw new GhError('hook_delete_failed', 'refused');
      client.hooks = client.hooks.filter((hook) => hook.id !== hookId);
      return 'deleted';
    },
    hook: async (_repo, hookId) => client.hooks.find((entry) => entry.id === hookId) ?? null,
  };
  return client;
}

interface Harness {
  readonly tracking: Tracking;
  readonly gh: FakeGhClient;
  readonly notifications: { content: string; meta: Record<string, string> }[];
  readonly logs: { level: LogLevel; event: string; fields: Record<string, unknown> }[];
  readonly janitorMessages: Record<string, unknown>[];
  readonly janitorClosed: () => boolean;
  readonly order: string[];
  readonly cacheDir: string;
  readonly ghChildren: FakeForwarderChild[];
  deliver(name: FixtureName, deliveryId?: string): Promise<void>;
}

interface FakeForwarderChild extends ChildHandle {
  connect(): void;
  exit(code: number): void;
  readonly signals: NodeJS.Signals[];
}

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(options: { gh?: FakeGhClient; config?: Partial<Config>; connect?: boolean; pingsOnSpawn?: number[] } = {}): Harness {
  const cacheDir = mkdtempSync(join(tmpdir(), 'pr-channel-tracking-'));
  dirs.push(cacheDir);
  const gh = options.gh ?? fakeGh();
  const notifications: Harness['notifications'] = [];
  const logs: Harness['logs'] = [];
  const janitorMessages: Record<string, unknown>[] = [];
  const order: string[] = [];
  const ghChildren: FakeForwarderChild[] = [];
  let janitorOpen = true;
  let onPing: ListenerOptions['onPing'] | null = null;
  let onDelivery: ListenerOptions['onDelivery'] | null = null;
  let nextHookId = 100;

  const spawnForwarder: SpawnForwarder = () => {
    order.push('gh_spawn');
    const created = nextHookId;
    nextHookId += 1;
    // gh creates a brand-new hook on every launch and leaves the previous one active.
    gh.hooks = [...gh.hooks, { id: created, active: true, createdAt: '2026-09-07T10:00:00Z' }];

    let push: ((line: string | null) => void) | null = null;
    const queue: string[] = [];
    let resolveExit: ((code: number) => void) | null = null;
    const signals: NodeJS.Signals[] = [];
    const stderrLines = (async function* () {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift() as string;
          continue;
        }
        const next = await new Promise<string | null>((resolve) => {
          push = resolve;
        });
        if (next === null) return;
        yield next;
      }
    })();
    const emit = (line: string): void => {
      if (push === null) queue.push(line);
      else push(line);
    };
    const child: FakeForwarderChild = {
      pid: 9000 + created,
      stderrLines,
      exited: new Promise<number>((resolve) => (resolveExit = resolve)),
      kill: (signal) => {
        order.push('gh_kill');
        signals.push(signal ?? 'SIGTERM');
        resolveExit?.(0);
        push?.(null);
      },
      connect: () => emit(`${CONNECT_LINE}\n`),
      exit: (code) => {
        resolveExit?.(code);
        push?.(null);
      },
      signals,
    };
    ghChildren.push(child);
    if (options.connect !== false) {
      setTimeout(() => {
        child.connect();
        // GitHub pings a hook the moment it is created; the ping reaches this session's
        // listener signed with this session's secret.
        for (const hookId of options.pingsOnSpawn ?? [created]) onPing?.({ hook_id: hookId }, Buffer.from(''));
      }, 1);
    }
    return child;
  };

  const spawnJanitor = (repo: string): JanitorHandle => {
    order.push('janitor_spawn');
    janitorMessages.push({ spawned: repo });
    return {
      pid: 4242,
      processStart: 'Mon Sep  7 10:00:00 2026',
      send: (message) => {
        if (janitorOpen) janitorMessages.push(message);
      },
      closeStdin: () => {
        order.push('janitor_close');
        janitorOpen = false;
      },
    };
  };

  const createListener = (listenerOptions: ListenerOptions): Listener => {
    order.push('listener_start');
    onPing = listenerOptions.onPing ?? null;
    onDelivery = listenerOptions.onDelivery;
    return {
      port: 45123,
      url: 'http://127.0.0.1:45123/webhook',
      stop: async () => {
        order.push('listener_stop');
      },
    };
  };

  const deps: TrackingDeps = {
    gh,
    config: config(options.config),
    notifier: {
      notification: async (notification) => {
        notifications.push({
          content: String(notification.params['content']),
          meta: notification.params['meta'] as Record<string, string>,
        });
      },
    },
    sessionId: 'session-1',
    projectDir: cacheDir,
    spawnForwarder,
    spawnJanitor,
    createListener,
    sweep: async () => ({ deletedHooks: [], killedGh: [], removedMarkers: 0, skippedLive: 0, failures: [] }),
    logger: (level, event, fields = {}) => logs.push({ level, event, fields }),
    wait: async () => {},
    processStart: () => 'Mon Sep  7 10:00:00 2026',
    connectTimeoutMs: 500,
    hookDiscoveryMs: 200,
    hookPollMs: 1,
  };

  const tracking = new Tracking({ ...deps, config: config({ cacheDir, ...options.config }) });

  return {
    tracking,
    gh,
    notifications,
    logs,
    janitorMessages,
    janitorClosed: () => !janitorOpen,
    order,
    cacheDir,
    ghChildren,
    deliver: async (name, deliveryId = `d-${Math.random()}`) => {
      await onDelivery?.(
        { eventName: fixtureEvent(name), deliveryId, repo: FIXTURE_REPO },
        loadFixture(name),
        Buffer.from(''),
      );
    },
  };
}

describe('track', () => {
  it('resolves the PR, starts everything in order and reports what is now flowing', async () => {
    const h = harness();

    const text = await h.tracking.track({ pr: '42', repo: FIXTURE_REPO });

    expect(h.tracking.state).toBe('tracking');
    expect(text).toContain(`${FIXTURE_REPO}#42`);
    expect(text).toContain(HEAD);
    expect(text).toContain('hook: 100');
    expect(text).toContain('listener: 127.0.0.1:45123');
    expect(text).toContain('Events before this moment were not captured and will not be replayed.');
    // The listener is up before gh exists, so no delivery can arrive at a closed port.
    expect(h.order.indexOf('listener_start')).toBeLessThan(h.order.indexOf('gh_spawn'));
    expect(h.order.indexOf('janitor_spawn')).toBeLessThan(h.order.indexOf('gh_spawn'));
  });

  it('refuses a PR that is already closed or merged', async () => {
    for (const state of ['CLOSED', 'MERGED'] as const) {
      const gh = fakeGh({ state });
      const h = harness({ gh });
      await expect(h.tracking.track({ pr: '42', repo: FIXTURE_REPO })).rejects.toMatchObject({ code: 'pr_closed' });
      expect(h.tracking.state).toBe('idle');
    }
  });

  it('refuses a second PR unless replace is asked for', async () => {
    const h = harness();
    await h.tracking.track({ pr: '42', repo: FIXTURE_REPO });

    await expect(h.tracking.track({ pr: '43', repo: FIXTURE_REPO })).rejects.toMatchObject({
      code: 'already_tracking',
    });

    const text = await h.tracking.track({ pr: '42', repo: FIXTURE_REPO, replace: true });
    expect(text).toContain('hook: 101');
    expect(h.gh.calls).toContain('deleteHook 100');
  });

  it('refuses when gh is not authenticated or the extension is missing', async () => {
    const unauthenticated = fakeGh();
    unauthenticated.authLogin = async () => {
      throw new GhError('gh_unauthenticated', 'not logged in');
    };
    await expect(harness({ gh: unauthenticated }).tracking.track({})).rejects.toMatchObject({
      code: 'gh_unauthenticated',
    });

    const noExtension = fakeGh();
    noExtension.extensionInstalled = async () => false;
    await expect(harness({ gh: noExtension }).tracking.track({})).rejects.toMatchObject({
      code: 'gh_webhook_extension_missing',
    });
  });

  it('reports gh\'s own last line when the forwarder never connects, and leaves nothing behind', async () => {
    const h = harness({ connect: false });

    await expect(h.tracking.track({ pr: '42', repo: FIXTURE_REPO })).rejects.toMatchObject({
      code: 'forwarder_failed',
    });

    expect(h.tracking.state).toBe('idle');
    expect(h.order).toContain('listener_stop');
    expect(h.order).toContain('janitor_close');
    expect(readMarkers(h.cacheDir)).toEqual([]);
  });

  it('confirms the hook id from the signed ping when several candidates appear at once', async () => {
    const gh = fakeGh();
    const h = harness({ gh, pingsOnSpawn: [100] });
    // Another session on another machine creates a hook in the same repo in the window.
    gh.listCliHooks = async () => {
      gh.calls.push('listCliHooks');
      return [...gh.hooks, { id: 555, active: true, createdAt: '2026-09-07T10:00:01Z' }];
    };

    const text = await h.tracking.track({ pr: '42', repo: FIXTURE_REPO });

    expect(text).toContain('hook: 100');
  });

  it('accepts a single new hook on the list diff alone when no ping arrives', async () => {
    const h = harness({ pingsOnSpawn: [] });

    expect(await h.tracking.track({ pr: '42', repo: FIXTURE_REPO })).toContain('hook: 100');
  });

  it('ignores a ping for a hook that was already there before gh started', async () => {
    const h = harness({ pingsOnSpawn: [7] });

    // 7 predates this session, so the ping proves nothing; the diff still names 100.
    expect(await h.tracking.track({ pr: '42', repo: FIXTURE_REPO })).toContain('hook: 100');
  });

  it('tears down and names the candidates when no hook id can be confirmed', async () => {
    const gh = fakeGh();
    const h = harness({ gh, pingsOnSpawn: [] });
    // A second session, anywhere, creates a hook in this repo inside the same window.
    let listed = 0;
    gh.listCliHooks = async () => {
      listed += 1;
      return listed === 1 ? [...gh.hooks] : [...gh.hooks, { id: 555, active: true, createdAt: '2026-09-07T10:00:01Z' }];
    };

    const error = await h.tracking.track({ pr: '42', repo: FIXTURE_REPO }).catch((caught: ToolError) => caught);

    expect(error).toMatchObject({ code: 'hook_unresolved' });
    expect((error as ToolError).message).toContain('555');
    expect((error as ToolError).message).toContain('gh api -X DELETE');
    expect(h.tracking.state).toBe('idle');
    // Both candidates are named by the marker, so teardown can delete what it cannot tell apart.
    expect(gh.calls.filter((call) => call.startsWith('deleteHook')).length).toBeGreaterThan(0);
    expect(readMarkers(h.cacheDir)).toEqual([]);
  });

  it('never writes the secret into argv, logs or the marker', async () => {
    const h = harness();
    await h.tracking.track({ pr: '42', repo: FIXTURE_REPO });

    const marker = JSON.stringify(readMarkers(h.cacheDir));
    expect(marker).not.toMatch(/secret/i);
    expect(JSON.stringify(h.logs)).not.toMatch(/secret/i);
    expect(JSON.stringify(h.janitorMessages)).not.toMatch(/secret/i);
    expect(process.argv.join(' ')).not.toMatch(/--secret/);
  });

  it('writes a marker before gh starts and fills in the hook id once it is known', async () => {
    const h = harness();
    await h.tracking.track({ pr: '42', repo: FIXTURE_REPO });

    expect(readMarkers(h.cacheDir)[0]?.marker).toMatchObject({
      repo: FIXTURE_REPO,
      hookId: 100,
      sessionId: 'session-1',
      janitorPid: 4242,
    });
    expect(h.janitorMessages.some((message) => message['marker'] !== undefined)).toBe(true);
    expect(h.janitorMessages.some((message) => message['hookId'] === 100)).toBe(true);
  });
});

describe('untrack', () => {
  it('stops the listener, then gh, then deletes the hook, then releases the janitor', async () => {
    const h = harness();
    await h.tracking.track({ pr: '42', repo: FIXTURE_REPO });
    h.order.length = 0;

    const text = await h.tracking.untrack();

    expect(text).toContain(`Stopped tracking ${FIXTURE_REPO}#42`);
    expect(text).toContain('Deleted webhook 100');
    expect(text).toContain('counters:');
    expect(h.order).toEqual(['listener_stop', 'gh_kill', 'janitor_close']);
    expect(h.gh.hooks.map((hook) => hook.id)).toEqual([7]);
    expect(readMarkers(h.cacheDir)).toEqual([]);
    expect(h.janitorMessages.at(-1)).toEqual({ done: true });
    expect(h.tracking.state).toBe('idle');
  });

  it('is idempotent when nothing is tracked', async () => {
    const h = harness();
    expect(await h.tracking.untrack()).toContain('Nothing was being tracked');
  });

  it('keeps the marker and never says done when the hook cannot be deleted', async () => {
    const h = harness();
    await h.tracking.track({ pr: '42', repo: FIXTURE_REPO });
    h.gh.deleteFailures.add(100);

    const error = await h.tracking.untrack().catch((caught: ToolError) => caught);

    expect(error).toMatchObject({ code: 'hook_delete_failed' });
    expect((error as ToolError).message).toContain('janitor is still retrying');
    expect(readMarkers(h.cacheDir)).toHaveLength(1);
    expect(h.janitorMessages).not.toContainEqual({ done: true });
    expect(h.janitorClosed()).toBe(true);
  });
});

describe('status', () => {
  it('reports nothing before tracking starts', async () => {
    expect(await harness().tracking.status()).toBe('tracking: no');
  });

  // The dead-forwarder-reported-healthy bug: the forwarder field comes from the live gh
  // child, never from a stored row.
  it('reports the live forwarder state, the hook, the port and the counters', async () => {
    const h = harness();
    await h.tracking.track({ pr: '42', repo: FIXTURE_REPO });

    const text = await h.tracking.status();

    expect(text).toContain('tracking: yes');
    expect(text).toContain(`pr: ${FIXTURE_REPO}#42`);
    expect(text).toContain(`head: ${HEAD} (source: registration`);
    expect(text).toContain('hook: 100');
    expect(text).toContain('forwarder: connected');
    expect(text).toContain('listener: 127.0.0.1:45123');
    expect(text).toContain('last delivery: none yet');
    expect(text).toContain('counters: received=0');
    expect(text).toContain('ci_events=completed');
  });

  it('asks GitHub whether the hook is still there when told to verify', async () => {
    const h = harness();
    await h.tracking.track({ pr: '42', repo: FIXTURE_REPO });

    expect(await h.tracking.status(true)).toContain('hook 100 exists, active=true');

    h.gh.hooks = h.gh.hooks.filter((hook) => hook.id !== 100);
    expect(await h.tracking.status(true)).toContain('is GONE');
  });
});

describe('delivery while tracking', () => {
  // Acting on a comment means pushing code, so the default trusts only the account this
  // machine is authenticated as; anyone else's comment is the author's to answer.
  it('ignores a comment from someone outside the comment-author allowlist', async () => {
    const h = harness();
    await h.tracking.track({ pr: '42', repo: FIXTURE_REPO });

    await h.deliver('prComment');

    expect(h.notifications).toEqual([]);
    expect(await h.tracking.status()).toContain('comment_authors=octo-worker');
  });

  it('pushes an event into the session and moves the counters', async () => {
    const h = harness();
    await h.tracking.track({ pr: '42', repo: FIXTURE_REPO, comment_authors: ['sam-reviewer'] });

    await h.deliver('prComment');

    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]?.meta).toMatchObject({ kind: 'pr_comment', pr: '42' });
    expect(await h.tracking.status()).toContain('delivered=1');
  });

  it('stops tracking by itself once the PR is merged', async () => {
    const h = harness();
    await h.tracking.track({ pr: '42', repo: FIXTURE_REPO });

    await h.deliver('prMerged');
    await Bun.sleep(20);

    expect(h.notifications.at(-1)?.meta['kind']).toBe('pr_lifecycle');
    expect(h.tracking.state).toBe('idle');
    expect(h.gh.hooks.map((hook) => hook.id)).toEqual([7]);
    expect(await h.tracking.status()).toContain('ended: merged');
    expect(readMarkers(h.cacheDir)).toEqual([]);
  });
});

describe('a forwarder that dies while tracking', () => {
  it('deletes the hook it is replacing, restarts, and rediscovers the new hook id', async () => {
    const h = harness();
    await h.tracking.track({ pr: '42', repo: FIXTURE_REPO });

    h.ghChildren.at(-1)?.exit(1);
    await waitFor(() => h.gh.hooks.some((hook) => hook.id === 101));
    await waitFor(() => (h.janitorMessages.at(-1) as Record<string, unknown>)?.['hookId'] === 101);

    const status = await h.tracking.status();
    expect(status).toContain('hook: 101');
    expect(status).toContain('restarts so far: 1');
    // The hook the dead gh left behind is gone before its replacement is adopted.
    expect(h.gh.calls).toContain('deleteHook 100');
    expect(readMarkers(h.cacheDir)[0]?.marker).toMatchObject({ hookId: 101 });
  });
});

describe('shutdown', () => {
  it('runs the untrack sequence so a session that ends leaves no hook behind', async () => {
    const h = harness();
    await h.tracking.track({ pr: '42', repo: FIXTURE_REPO });

    await h.tracking.shutdown();

    expect(h.gh.hooks.map((hook) => hook.id)).toEqual([7]);
    expect(readMarkers(h.cacheDir)).toEqual([]);
    expect(h.janitorClosed()).toBe(true);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error('condition never became true');
}
