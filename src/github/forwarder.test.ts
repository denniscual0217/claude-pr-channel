import { describe, expect, it } from 'bun:test';
import { CONNECT_LINE, SECRET_ENV, createForwarder, lines, type ChildHandle, type SpawnForwarder } from './forwarder.js';

const SECRET = 'test-only-fake-secret';

interface FakeChild extends ChildHandle {
  emit(line: string): void;
  exit(code: number): void;
  readonly signals: NodeJS.Signals[];
}

interface FakeSpawn {
  readonly spawn: SpawnForwarder;
  readonly children: FakeChild[];
  readonly argvs: string[][];
  readonly envs: Record<string, string>[];
  latest(): FakeChild;
}

function fakeSpawn(behaviour: (child: FakeChild, attempt: number) => void = () => {}): FakeSpawn {
  const children: FakeChild[] = [];
  const argvs: string[][] = [];
  const envs: Record<string, string>[] = [];
  let nextPid = 5000;

  const spawn: SpawnForwarder = (args, env) => {
    argvs.push([...args]);
    envs.push({ ...env });
    const queue: string[] = [];
    let push: ((line: string) => void) | null = null;
    let finish: (() => void) | null = null;
    let resolveExit: ((code: number) => void) | null = null;
    const signals: NodeJS.Signals[] = [];

    const stderrLines = (async function* () {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift() as string;
          continue;
        }
        const next = await new Promise<string | null>((resolve) => {
          push = (line) => resolve(line);
          finish = () => resolve(null);
        });
        if (next === null) return;
        yield next;
      }
    })();

    nextPid += 1;
    const child: FakeChild = {
      pid: nextPid,
      stderrLines,
      exited: new Promise<number>((resolve) => {
        resolveExit = resolve;
      }),
      kill: (signal) => {
        signals.push(signal ?? 'SIGTERM');
        resolveExit?.(0);
        finish?.();
      },
      emit: (line) => (push === null ? queue.push(line) : push(line)),
      exit: (code) => {
        resolveExit?.(code);
        finish?.();
      },
      signals,
    };
    children.push(child);
    behaviour(child, children.length);
    return child;
  };

  return { spawn, children, argvs, envs, latest: () => children[children.length - 1] as FakeChild };
}

function build(fake: FakeSpawn, overrides: Record<string, unknown> = {}) {
  const waits: number[] = [];
  const forwarder = createForwarder({
    repo: 'acme-labs/example',
    events: ['pull_request', 'check_run'],
    url: 'http://127.0.0.1:4321/webhook',
    secret: SECRET,
    spawn: fake.spawn,
    connectTimeoutMs: 200,
    backoffStartMs: 2_000,
    backoffMaxMs: 60_000,
    wait: async (ms) => {
      waits.push(ms);
    },
    ...overrides,
  });
  return { forwarder, waits };
}

describe('the forwarder', () => {
  it('connects when gh reports it is forwarding, and passes the secret through the environment', async () => {
    const fake = fakeSpawn((child) => setTimeout(() => child.emit(`${CONNECT_LINE}\n`), 5));
    const { forwarder } = build(fake);

    await forwarder.start();

    expect(forwarder.state).toBe('connected');
    expect(fake.argvs[0]).toEqual([
      'webhook',
      'forward',
      '--events=pull_request,check_run',
      '--repo=acme-labs/example',
      '--url=http://127.0.0.1:4321/webhook',
      `--secret=${SECRET}`,
    ]);
    // gh only takes the secret on argv, which is unavoidable; it is handed over through
    // the child's environment as well so nothing of ours has to build that argv twice.
    expect(fake.envs[0]).toEqual({ [SECRET_ENV]: SECRET });
  });

  it('fails with gh\'s own last line when it never connects', async () => {
    const fake = fakeSpawn((child) => {
      child.emit('HTTP 403: you do not have access to this feature\n');
      setTimeout(() => child.exit(1), 5);
    });
    const { forwarder } = build(fake);

    await expect(forwarder.start()).rejects.toMatchObject({
      code: 'forwarder_failed',
      stderrTail: 'HTTP 403: you do not have access to this feature',
    });
    expect(forwarder.state).toBe('dead');
  });

  it('fails on timeout when gh says nothing at all', async () => {
    const fake = fakeSpawn();
    const { forwarder } = build(fake, { connectTimeoutMs: 50 });

    await expect(forwarder.start()).rejects.toMatchObject({ code: 'forwarder_failed' });
  });

  // gh exits on its own with "websocket: close 1006" and leaves its hook behind.
  it('restarts after gh exits, deleting the hook it is about to replace', async () => {
    const deleted: number[] = [];
    const connected: number[] = [];
    const fake = fakeSpawn((child) => setTimeout(() => child.emit(`${CONNECT_LINE}\n`), 5));
    const { forwarder, waits } = build(fake, {
      onBeforeRespawn: async () => {
        deleted.push(1);
      },
      onConnected: async (attempt: number) => {
        connected.push(attempt);
      },
    });

    await forwarder.start();
    fake.latest().emit('websocket: close 1006\n');
    fake.latest().exit(1);

    await until(() => forwarder.state === 'connected' && forwarder.restarts === 1);
    expect(waits).toEqual([2_000]);
    expect(deleted).toEqual([1]);
    expect(connected).toEqual([1]);
    expect(fake.children).toHaveLength(2);
  });

  it('backs off 2s, doubling to a 60s ceiling, while the restarts keep failing', async () => {
    let attempts = 0;
    const fake = fakeSpawn((child) => {
      attempts += 1;
      if (attempts === 1) setTimeout(() => child.emit(`${CONNECT_LINE}\n`), 5);
      else setTimeout(() => child.exit(1), 1);
    });
    const { forwarder, waits } = build(fake, { connectTimeoutMs: 50, maxRestarts: 7 });

    await forwarder.start();
    fake.latest().exit(1);

    await until(() => forwarder.state === 'dead');
    expect(waits).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  });

  it('reports restarting with the next retry while it waits', async () => {
    let resolveWait: (() => void) | null = null;
    let attempts = 0;
    const fake = fakeSpawn((child) => {
      attempts += 1;
      if (attempts === 1) setTimeout(() => child.emit(`${CONNECT_LINE}\n`), 5);
    });
    const { forwarder } = build(fake, {
      wait: () => new Promise<void>((resolve) => (resolveWait = resolve)),
    });

    await forwarder.start();
    fake.latest().exit(1);
    await until(() => forwarder.state === 'restarting');

    expect(forwarder.restarts).toBe(1);
    expect(forwarder.nextRetryInMs).toBe(2_000);
    (resolveWait as unknown as () => void)?.();
  });

  // The hook clean-up between two launches takes several GitHub round trips, and an
  // untrack, a merged PR or a session ending lands inside it routinely. A gh spawned after
  // that creates a hook nothing left alive would ever delete.
  it('never spawns a replacement when stop lands inside onBeforeRespawn', async () => {
    let releaseRespawn: (() => void) | null = null;
    let inRespawn = false;
    const fake = fakeSpawn((child) => setTimeout(() => child.emit(`${CONNECT_LINE}\n`), 5));
    const { forwarder } = build(fake, {
      onBeforeRespawn: () =>
        new Promise<void>((resolve) => {
          inRespawn = true;
          releaseRespawn = resolve;
        }),
    });

    await forwarder.start();
    fake.latest().exit(1);
    await until(() => inRespawn);

    const stopping = forwarder.stop();
    (releaseRespawn as unknown as () => void)();
    await stopping;

    expect(fake.children).toHaveLength(1);
    expect(forwarder.state).toBe('dead');
  });

  // stop() returning while the restart is still mid-flight is what lets a tear-down delete
  // hooks the respawn is about to recreate.
  it('waits for a restart already under way before it returns', async () => {
    let releaseRespawn: (() => void) | null = null;
    let inRespawn = false;
    let respawnFinished = false;
    const fake = fakeSpawn((child) => setTimeout(() => child.emit(`${CONNECT_LINE}\n`), 5));
    const { forwarder } = build(fake, {
      onBeforeRespawn: () =>
        new Promise<void>((resolve) => {
          inRespawn = true;
          releaseRespawn = () => {
            respawnFinished = true;
            resolve();
          };
        }),
    });

    await forwarder.start();
    fake.latest().exit(1);
    await until(() => inRespawn);

    const stopping = forwarder.stop();
    let returned = false;
    void stopping.then(() => (returned = true));
    await Bun.sleep(20);
    expect(returned).toBe(false);

    (releaseRespawn as unknown as () => void)();
    await stopping;
    expect(respawnFinished).toBe(true);
  });

  // A 60s backoff must not become a 60s untrack.
  it('abandons the backoff the moment it is stopped', async () => {
    const fake = fakeSpawn((child) => setTimeout(() => child.emit(`${CONNECT_LINE}\n`), 5));
    const { forwarder } = build(fake, { wait: () => new Promise<void>(() => {}) });

    await forwarder.start();
    fake.latest().exit(1);
    await until(() => forwarder.state === 'restarting');

    await forwarder.stop();

    expect(fake.children).toHaveLength(1);
    expect(forwarder.state).toBe('dead');
  });

  it('stops by asking gh to go, and stops supervising once it has', async () => {
    const fake = fakeSpawn((child) => setTimeout(() => child.emit(`${CONNECT_LINE}\n`), 5));
    const { forwarder } = build(fake);

    await forwarder.start();
    const child = fake.latest();
    await forwarder.stop();

    expect(child.signals).toEqual(['SIGTERM']);
    expect(forwarder.state).toBe('dead');
    expect(fake.children).toHaveLength(1);
  });
});

describe('lines', () => {
  it('yields the connect line before gh flushes a newline after it', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('level=info msg=starting\n'));
        controller.enqueue(new TextEncoder().encode(CONNECT_LINE));
        controller.close();
      },
    });

    const seen: string[] = [];
    for await (const line of lines(stream)) seen.push(line);

    expect(seen[0]).toBe('level=info msg=starting');
    expect(seen.some((line) => line.includes(CONNECT_LINE))).toBe(true);
  });
});

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error('condition never became true');
}
