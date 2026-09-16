import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Tracking, ToolError, type JanitorHandle, type TrackingDeps } from '../src/channel/tracking.js';
import { CONNECT_LINE, type ChildHandle, type SpawnForwarder } from '../src/github/forwarder.js';
import type { DeleteHookResult, GhClient, HookInfo, PrInfo } from '../src/github/gh.js';
import { GhError } from '../src/github/gh.js';
import { readMarkers } from '../src/github/markers.js';
import type { Config, ConfigLoad } from '../src/config.js';
import { ConfigError, DEFAULT_CONFIG } from '../src/config.js';
import type { LogLevel } from '../src/log.js';
import { loadFixture, FIXTURE_REPO, fixtureEvent, type FixtureName } from './fixtures/index.js';
import type { Listener, ListenerOptions } from '../src/webhook/listener.js';

const HEAD = '4d0f1a2b3c4d5e6f70819a2b3c4d5e6f70819a2b';

function config(overrides: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    events: {
      ...DEFAULT_CONFIG.events,
    },
    limits: { maxPayloadBytes: 1_048_576, rateLimit: { maxDeliveries: 500, windowMs: 60_000 } },
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
  readonly configPath: string;
  readonly sweeps: () => number;
  readonly ghChildren: FakeForwarderChild[];
  // GitHub's own ping for a hook, verified against this session's secret.
  ping(hookId: number): void;
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

interface HarnessOptions {
  gh?: FakeGhClient;
  config?: Partial<Config>;
  loadConfig?: () => ConfigLoad;
  sweepOnTrack?: boolean;
  connect?: boolean;
  pingsOnSpawn?: number[];
  // The id the first gh launch of this session creates; later launches take the next ones.
  firstHookId?: number;
  // Launches from this index on create their hook and then never report connected.
  stallConnectFrom?: number;
  // Runs when a launch has created its hook, so a test can make another session's hook
  // appear in the same window.
  onSpawn?: (index: number, hookId: number) => void;
}

function harness(options: HarnessOptions = {}): Harness {
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
  let nextHookId = options.firstHookId ?? 100;

  const spawnForwarder: SpawnForwarder = () => {
    order.push('gh_spawn');
    const index = ghChildren.length;
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
    options.onSpawn?.(index, created);
    if (options.connect !== false && index < (options.stallConnectFrom ?? Number.POSITIVE_INFINITY)) {
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

  const configPath = join(cacheDir, 'config.json');
  // The marker directory is always the temp one, whatever else a test overrides: a config
  // that fell back to the real cache dir would write into the machine's own markers.
  const inForce: Config = {
    ...config(options.config),
    cache: { dir: cacheDir, sweepOnTrack: options.sweepOnTrack ?? true },
  };
  let sweeps = 0;

  const deps: TrackingDeps = {
    gh,
    loadConfig: options.loadConfig ?? (() => ({ ok: true, config: inForce, path: configPath, source: 'file' })),
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
    sweep: async () => {
      sweeps += 1;
      return { deletedHooks: [], killedGh: [], removedMarkers: 0, skippedLive: 0, failures: [] };
    },
    logger: (level, event, fields = {}) => logs.push({ level, event, fields }),
    wait: async () => {},
    processStart: () => 'Mon Sep  7 10:00:00 2026',
    connectTimeoutMs: 500,
    hookDiscoveryMs: 200,
    hookPollMs: 1,
  };

  const tracking = new Tracking(deps);

  return {
    tracking,
    gh,
    notifications,
    logs,
    janitorMessages,
    janitorClosed: () => !janitorOpen,
    order,
    cacheDir,
    configPath,
    sweeps: () => sweeps,
    ghChildren,
    ping: (hookId) => onPing?.({ hook_id: hookId }, Buffer.from('')),
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
    // gh creates its hook before it dials, so a launch that never connects still leaves
    // one on the repository, and no signed ping ever named it. It stays: on this repo the
    // unproven hook could as easily be another session's.
    expect(h.gh.hooks.map((hook) => hook.id)).toEqual([7, 100]);
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

  it('claims no hook when no signed ping arrives, however unambiguous the list looks', async () => {
    const h = harness({ pingsOnSpawn: [] });

    // One unfamiliar hook on the repo used to be treated as proof. It is not: on a repo
    // where another session tracks a different PR, that hook is as likely to be theirs.
    // Delivery works regardless — only cleanup needs the id — so it tracks and says the
    // hook is unconfirmed rather than throwing away a working channel.
    expect(await h.tracking.track({ pr: '42', repo: FIXTURE_REPO })).toContain('hook: unconfirmed');
  });

  it('accepts a signed ping even for a hook that predates this launch: only our secret can sign it', async () => {
    const h = harness({ pingsOnSpawn: [7] });

    // The secret is generated per session, so GitHub can only produce a ping we accept
    // for a hook carrying our secret. When it arrived is irrelevant to whose it is.
    expect(await h.tracking.track({ pr: '42', repo: FIXTURE_REPO })).toContain('hook: 7');
  });

  it('keeps tracking and reports the hook as unconfirmed when nothing proves which is ours', async () => {
    const gh = fakeGh();
    const h = harness({ gh, pingsOnSpawn: [] });
    // A second session, anywhere, creates a hook in this repo inside the same window.
    let listed = 0;
    gh.listCliHooks = async () => {
      listed += 1;
      return listed === 1 ? [...gh.hooks] : [...gh.hooks, { id: 555, active: true, createdAt: '2026-09-07T10:00:01Z' }];
    };

    const text = await h.tracking.track({ pr: '42', repo: FIXTURE_REPO });

    // Events are already flowing, so an unnameable hook is reported rather than fatal.
    expect(text).toContain('hook: unconfirmed');
    expect(h.tracking.state).toBe('tracking');
    // One of the two may be the other session's, and deleting that one would silently stop
    // its events, so neither is touched; the ids are in the error for a human to judge.
    expect(gh.calls.filter((call) => call.startsWith('deleteHook'))).toEqual([]);
    // 555 is only ever in the listing, like a hook another session owns; 100 is gh's own.
    expect(gh.hooks.map((hook) => hook.id)).toEqual([7, 100]);
    // Tracking continues, so the marker stays for the janitor to act on.
    expect(readMarkers(h.cacheDir)).toHaveLength(1);
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
  it('reports nothing before tracking starts, and where the config came from', async () => {
    const h = harness();

    const text = await h.tracking.status();

    expect(text.split('\n')[0]).toBe('tracking: no');
    expect(text).toContain(`config: ${h.configPath} (file)`);
    expect(text).toContain('schema/config.schema.json');
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

describe('another session on the same repository', () => {
  // The hook another session created inside our discovery window is new against our
  // snapshot too, but only the ping signed with our own secret says which one is ours.
  // Deleting the other one stops its events with nothing to show for it.
  it('never deletes the hook a second session confirmed as its own', async () => {
    const gh = fakeGh();
    // The ping travels back over gh's websocket, so it lands after the first listing:
    // that is the window in which another session's hook looks exactly like ours.
    const a = harness({ gh, pingsOnSpawn: [] });
    const b = harness({ gh, firstHookId: 200 });
    const list = gh.listCliHooks;
    let listed = 0;
    gh.listCliHooks = async (repo) => {
      listed += 1;
      // The second session starts and finishes inside the first one's discovery window.
      if (listed === 2) {
        await b.tracking.track({ pr: '43', repo: FIXTURE_REPO });
        a.ping(100);
      }
      return list(repo);
    };

    expect(await a.tracking.track({ pr: '42', repo: FIXTURE_REPO })).toContain('hook: 100');
    expect(await b.tracking.status()).toContain('hook: 200');

    const text = await a.tracking.untrack();

    expect(text).toContain('Deleted webhook 100.');
    expect(gh.calls).not.toContain('deleteHook 200');
    expect(gh.hooks.map((hook) => hook.id)).toEqual([7, 200]);
    expect(await b.tracking.status(true)).toContain('hook 200 exists');
  });

  // gh exits on its own with "websocket: close 1006", so this restart is the steady state,
  // not a failure. Once our own confirmed hook is deleted, every other hook on the repo is
  // someone else's — including one a session that started after us created.
  it('never deletes the hook of a session that started while this one was tracking', async () => {
    const gh = fakeGh();
    const a = harness({ gh });
    const b = harness({ gh, firstHookId: 200 });
    await a.tracking.track({ pr: '42', repo: FIXTURE_REPO });
    await b.tracking.track({ pr: '43', repo: FIXTURE_REPO });

    a.ghChildren[0]?.exit(1);
    await waitFor(() => (a.janitorMessages.at(-1) as Record<string, unknown>)?.['hookId'] === 101);

    expect(gh.calls).toContain('deleteHook 100');
    expect(gh.calls).not.toContain('deleteHook 200');
    expect(gh.hooks.map((hook) => hook.id)).toEqual([7, 200, 101]);
    expect(await b.tracking.status(true)).toContain('hook 200 exists');
  });

  // The janitor is what deletes the hook when the channel is SIGKILLed. A cleared hook id
  // beside the snapshot from before the launch that created it reads another session's
  // hook as our stray.
  it('never leaves the janitor a cleared hook id without the snapshot that goes with it', async () => {
    const h = harness();
    await h.tracking.track({ pr: '42', repo: FIXTURE_REPO });

    h.ghChildren[0]?.exit(1);
    await waitFor(() => (h.janitorMessages.at(-1) as Record<string, unknown>)?.['hookId'] === 101);

    const cleared = h.janitorMessages.filter((message) => message['hookId'] === null);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]?.['snapshot']).toEqual([7]);
  });

  it('leaves every unproven hook alone, whether or not it can tell them apart', async () => {
    const gh = fakeGh();
    const h = harness({
      gh,
      pingsOnSpawn: [],
      onSpawn: (index) => {
        if (index === 1) gh.hooks = [...gh.hooks, { id: 555, active: true, createdAt: '2026-09-07T10:00:02Z' }];
      },
    });
    await h.tracking.track({ pr: '42', repo: FIXTURE_REPO });

    h.ghChildren[0]?.exit(1);
    await waitFor(() => (h.janitorMessages.at(-1) as Record<string, unknown>)?.['ghPid'] === 9101);

    const text = await h.tracking.untrack();

    expect((await h.tracking.status()).split('\n')[0]).toBe('tracking: no');
    expect(gh.calls).not.toContain('deleteHook 555');
    expect(gh.calls).not.toContain('deleteHook 101');
    expect(gh.hooks.map((hook) => hook.id)).toEqual([7, 100, 101, 555]);
    expect(text).toContain('Left in place');
    expect(text).toContain('could not be proved to be its own');
  });
});

describe('a hook gh created that was never confirmed', () => {
  it('is left behind when untrack lands inside a forwarder restart, rather than risking one that is not ours', async () => {
    const h = harness({ stallConnectFrom: 1 });
    await h.tracking.track({ pr: '42', repo: FIXTURE_REPO });

    // gh exits on its own with "websocket: close 1006"; its replacement creates a fresh
    // hook before it connects, and untrack can land in exactly that window.
    h.ghChildren[0]?.exit(1);
    await waitFor(() => h.gh.hooks.some((hook) => hook.id === 101));

    const text = await h.tracking.untrack();

    expect(text).toContain('Left in place');
    expect(text).toContain('could not be proved to be its own');
    // Unproven, so it stays: deleting it risks another session's hook on this repo.
    expect(h.gh.hooks.map((hook) => hook.id)).toEqual([7, 101]);
    expect(readMarkers(h.cacheDir)).toEqual([]);
  });

  it('is left behind when a restart never connects, rather than risking one that is not ours', async () => {
    const h = harness({ stallConnectFrom: 1 });
    await h.tracking.track({ pr: '42', repo: FIXTURE_REPO });

    h.ghChildren[0]?.exit(1);
    // Each failed launch leaves a hook behind and none of them can be proved ours, so
    // none is deleted. They are reported instead — a leak a human can clear, rather than
    // a deletion that might stop another session's events.
    await waitFor(() => h.gh.hooks.some((hook) => hook.id === 101));

    expect(h.gh.calls).not.toContain('deleteHook 101');
    const text = await h.tracking.untrack();
    expect(text).toContain('Left in place');
  }, 10_000);

  it('tells the janitor what was on the repository before gh started', async () => {
    const h = harness();
    await h.tracking.track({ pr: '42', repo: FIXTURE_REPO });

    // The SIGKILL backstop has no other way to tell a hook gh created from anyone else's.
    expect(h.janitorMessages.some((message) => Array.isArray(message['snapshot']))).toBe(true);
  });
});

describe('a tear-down that lands inside a forwarder restart', () => {
  // The hook clean-up between two launches is several GitHub round trips long; an untrack
  // in that window used to let the respawn spawn a gh, and a hook, behind it.
  it('leaves no gh and no hook behind when untrack lands in the middle of it', async () => {
    const gh = fakeGh();
    let release: (() => void) | null = null;
    const gated = new Promise<void>((resolve) => (release = resolve));
    const deleteHook = gh.deleteHook;
    let entered = false;
    gh.deleteHook = async (repo, hookId) => {
      if (!entered) {
        entered = true;
        await gated;
      }
      return deleteHook(repo, hookId);
    };
    const h = harness({ gh });
    await h.tracking.track({ pr: '42', repo: FIXTURE_REPO });

    h.ghChildren[0]?.exit(1);
    await waitFor(() => entered);
    const untracking = h.tracking.untrack();
    await Bun.sleep(10);
    (release as unknown as () => void)();
    const text = await untracking;
    // Everything the respawn has left to do is microtasks; this is its whole chance to
    // spawn a gh behind the tear-down.
    await Bun.sleep(50);

    expect(h.ghChildren).toHaveLength(1);
    expect(gh.hooks.map((hook) => hook.id)).toEqual([7]);
    expect(readMarkers(h.cacheDir)).toEqual([]);
    expect(h.tracking.state).toBe('idle');
    expect(text).toContain(`Stopped tracking ${FIXTURE_REPO}#42`);
  });

  it('leaves no gh and no hook behind when the PR merges in the middle of it', async () => {
    const gh = fakeGh();
    let release: (() => void) | null = null;
    const gated = new Promise<void>((resolve) => (release = resolve));
    const deleteHook = gh.deleteHook;
    let entered = false;
    gh.deleteHook = async (repo, hookId) => {
      if (!entered) {
        entered = true;
        await gated;
      }
      return deleteHook(repo, hookId);
    };
    const h = harness({ gh });
    await h.tracking.track({ pr: '42', repo: FIXTURE_REPO });

    h.ghChildren[0]?.exit(1);
    await waitFor(() => entered);
    await h.deliver('prMerged');
    await Bun.sleep(10);
    (release as unknown as () => void)();
    await waitFor(() => h.tracking.state === 'idle');
    await Bun.sleep(50);

    expect(h.ghChildren).toHaveLength(1);
    expect(gh.hooks.map((hook) => hook.id)).toEqual([7]);
    expect(readMarkers(h.cacheDir)).toEqual([]);
  });
});

describe('a hook the restart could not delete', () => {
  // gh drops its websocket precisely when the network is flaky, and the DELETE goes out
  // into the same blip. Forgetting the id here orphans the hook: no marker, no janitor and
  // no sweep would ever name it again.
  it('is named by the marker and the janitor, and deleted by the next attempt', async () => {
    const h = harness();
    h.gh.deleteFailures.add(100);
    await h.tracking.track({ pr: '42', repo: FIXTURE_REPO });

    h.ghChildren[0]?.exit(1);
    await waitFor(() => (h.janitorMessages.at(-1) as Record<string, unknown>)?.['hookId'] === 101);

    expect(readMarkers(h.cacheDir)[0]?.marker).toMatchObject({ hookId: 101, pendingHookIds: [100] });
    expect(
      h.janitorMessages.some((message) => JSON.stringify(message['pendingDeletes'] ?? null) === '[100]'),
    ).toBe(true);

    h.gh.deleteFailures.clear();
    await h.tracking.untrack();

    expect(h.gh.hooks.map((hook) => hook.id)).toEqual([7]);
    expect(readMarkers(h.cacheDir)).toEqual([]);
  });

  it('keeps its marker when even the tear-down cannot delete it', async () => {
    const h = harness();
    h.gh.deleteFailures.add(100);
    await h.tracking.track({ pr: '42', repo: FIXTURE_REPO });

    h.ghChildren[0]?.exit(1);
    await waitFor(() => (h.janitorMessages.at(-1) as Record<string, unknown>)?.['hookId'] === 101);

    await expect(h.tracking.untrack()).rejects.toMatchObject({ code: 'hook_delete_failed' });

    expect(h.gh.hooks.map((hook) => hook.id)).toEqual([7, 100]);
    expect(readMarkers(h.cacheDir)[0]?.marker).toMatchObject({ pendingHookIds: [100] });
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

describe('a track argument that is not one of the allowed values', () => {
  // The argument outranks the config file, so an unchecked one is the widest hole of the
  // three layers: "Ignore" matches neither branch of the bot filter and would be read as
  // "handle", widening the trust boundary in the direction the operator asked to close it.
  it('is refused by name, and nothing is started on the strength of it', async () => {
    const h = harness();

    await expect(h.tracking.track({ pr: '42', repo: FIXTURE_REPO, bot_comments: 'Ignore' })).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'bot_comments: "Ignore" is not allowed; expected one of "handle", "ignore"',
    });

    expect(h.tracking.state).toBe('idle');
    expect(h.order).toEqual([]);
    expect(h.gh.calls).toEqual([]);
    expect(readMarkers(h.cacheDir)).toEqual([]);
  });

  it('is refused whatever the shape of the mistake', async () => {
    const h = harness();

    await expect(h.tracking.track({ ci_events: 'Completed' })).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(h.tracking.track({ replace: 'yes' })).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(h.tracking.track({ ci_event: 'all' })).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(h.order).toEqual([]);
  });

  it('leaves a session that is already tracking exactly as it was', async () => {
    const h = harness();
    await h.tracking.track({ pr: '42', repo: FIXTURE_REPO });

    await expect(h.tracking.track({ pr: '43', replace: true, bot_comments: 'Ignore' })).rejects.toMatchObject({
      code: 'invalid_argument',
    });

    expect(h.tracking.state).toBe('tracking');
    expect(h.tracking.trackedPr).toMatchObject({ prNumber: 42 });
    expect(await h.tracking.status()).toContain('bot_comments=handle');
  });
});

describe('the config file', () => {
  it('refuses to track at all while it cannot be used, and spawns nothing', async () => {
    const h = harness({
      loadConfig: () => ({
        ok: false,
        path: '/cfg/config.json',
        error: new ConfigError('events.checks.wake: "sometimes" is not allowed; expected one of "failures", "completed", "all"'),
      }),
    });

    await expect(h.tracking.track({ pr: '42', repo: FIXTURE_REPO })).rejects.toMatchObject({
      code: 'config_invalid',
      message: expect.stringContaining('events.checks.wake'),
    });

    expect(h.tracking.state).toBe('idle');
    expect(h.order).toEqual([]);
    expect(readMarkers(h.cacheDir)).toEqual([]);
  });

  it('reports where its values came from, so a file that changed nothing is visible', async () => {
    const h = harness();

    const text = await h.tracking.track({ pr: '42', repo: FIXTURE_REPO, ci_events: 'all' });

    expect(text).toContain(`config: ${h.configPath} (file)`);
    expect(text).toContain('ci_events=all (argument)');
    expect(text).toContain('comment_authors=octo-worker (default: gh login)');
    expect(text).toContain('bot_comments=handle (default)');
    expect(await h.tracking.status()).toContain('ci_events=all (argument)');
  });

  it('reports the listed bots on the filters line', async () => {
    const h = harness({
      config: { authors: { mode: 'operator', allow: [], bots: 'listed', allowBots: ['coderabbitai[bot]'] } },
    });

    const text = await h.tracking.track({ pr: '42', repo: FIXTURE_REPO });

    expect(text).toContain('bot_comments=listed: coderabbitai[bot] (config)');
  });

  it('skips the startup sweep when the config turns it off', async () => {
    const swept = harness();
    await swept.tracking.track({ pr: '42', repo: FIXTURE_REPO });
    expect(swept.sweeps()).toBe(1);

    const unswept = harness({ sweepOnTrack: false });
    await unswept.tracking.track({ pr: '42', repo: FIXTURE_REPO });
    expect(unswept.sweeps()).toBe(0);
  });
});
