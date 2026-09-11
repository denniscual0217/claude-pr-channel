import type { Logger } from '../log.js';
import { noopLogger } from '../log.js';

export const CONNECT_LINE = 'Forwarding Webhook events from GitHub...';
export const SECRET_ENV = 'PR_CHANNEL_WEBHOOK_SECRET';

export type ForwarderState = 'starting' | 'connected' | 'restarting' | 'dead';

export interface ChildHandle {
  readonly pid: number;
  readonly stderrLines: AsyncIterable<string>;
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

export type SpawnForwarder = (args: readonly string[], env: Record<string, string>) => ChildHandle;

export interface ForwarderOptions {
  readonly repo: string;
  readonly events: readonly string[];
  readonly url: string;
  // Handed over only here, and only into the child's environment. gh re-exposes it on its
  // own argv, which is unavoidable; nothing of ours puts it there.
  readonly secret: string;
  readonly spawn: SpawnForwarder;
  readonly connectTimeoutMs?: number;
  readonly backoffStartMs?: number;
  readonly backoffMaxMs?: number;
  readonly maxRestarts?: number;
  readonly logger?: Logger;
  readonly wait?: (ms: number) => Promise<void>;
  readonly processStart?: (pid: number) => string | null;
  // Runs after the old gh has exited and before the new one starts: gh creates a fresh
  // hook every launch and leaves the old one active, so the old one is deleted here.
  readonly onBeforeRespawn?: () => Promise<void>;
  readonly onConnected?: (attempt: number) => Promise<void>;
}

export class ForwarderError extends Error {
  override readonly name = 'ForwarderError';
  readonly code = 'forwarder_failed';
  readonly stderrTail: string;

  constructor(message: string, stderrTail: string) {
    super(message);
    this.stderrTail = stderrTail;
  }
}

export interface Forwarder {
  readonly state: ForwarderState;
  readonly restarts: number;
  readonly pid: number | null;
  readonly processStart: string | null;
  readonly lastStderrLine: string | null;
  readonly nextRetryInMs: number | null;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createForwarder(options: ForwarderOptions): Forwarder {
  const log = options.logger ?? noopLogger;
  const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
  const backoffStartMs = options.backoffStartMs ?? 2_000;
  const backoffMaxMs = options.backoffMaxMs ?? 60_000;
  const maxRestarts = options.maxRestarts ?? Number.POSITIVE_INFINITY;
  const processStart = options.processStart ?? (() => null);

  const args = [
    'webhook',
    'forward',
    `--events=${options.events.join(',')}`,
    `--repo=${options.repo}`,
    `--url=${options.url}`,
    `--secret=${options.secret}`,
  ];

  let state: ForwarderState = 'starting';
  let child: ChildHandle | null = null;
  let restarts = 0;
  let lastStderrLine: string | null = null;
  let currentStart: string | null = null;
  let nextRetryInMs: number | null = null;
  let stopped = false;
  // A restart iteration in flight when stop() is called owns hooks the teardown is about
  // to reason about, so stop() waits for it rather than racing it.
  let restarting: Promise<void> | null = null;
  let releaseStopped: () => void = () => {};
  const stoppedSignal = new Promise<void>((resolve) => {
    releaseStopped = resolve;
  });

  async function launch(): Promise<void> {
    // Nothing may reach spawn() after stop(): a gh started then creates a hook that no
    // marker, janitor or sweep will ever name.
    if (stopped) throw new ForwarderError('gh webhook forward was stopped before it could be launched', '');
    const handle = options.spawn(args, { [SECRET_ENV]: options.secret });
    child = handle;
    currentStart = processStart(handle.pid);

    let connected = false;
    const connectedPromise = new Promise<void>((resolve) => {
      void (async () => {
        for await (const line of handle.stderrLines) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          lastStderrLine = trimmed;
          if (!connected && trimmed.includes(CONNECT_LINE)) {
            connected = true;
            resolve();
          }
        }
      })();
    });

    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), connectTimeoutMs));
    const exited = handle.exited.then(() => 'exited' as const);
    const outcome = await Promise.race([connectedPromise.then(() => 'connected' as const), exited, timeout]);

    if (outcome !== 'connected') {
      state = 'dead';
      // A launch that timed out is still running: it created its webhook and is dialling.
      // Left alive it outlives every tear-down, unknown to stop(), the marker and the
      // janitor, and keeps a hook pointed at a port nobody is listening on.
      if (outcome === 'timeout') await killHandle(handle);
      throw new ForwarderError(
        outcome === 'timeout'
          ? `gh webhook forward did not report "${CONNECT_LINE}" within ${connectTimeoutMs} ms`
          : 'gh webhook forward exited before it connected',
        lastStderrLine ?? '',
      );
    }
    state = 'connected';
    nextRetryInMs = null;
    log('info', 'forwarder_connected', { pid: handle.pid, restarts });
  }

  function superviseExit(handle: ChildHandle): void {
    void handle.exited.then(async (code) => {
      if (stopped || child !== handle) return;
      log('warn', 'forwarder_exited', { pid: handle.pid, code, restarts });
      const cycle = restartLoop();
      restarting = cycle;
      try {
        await cycle;
      } finally {
        if (restarting === cycle) restarting = null;
      }
    });
  }

  async function restartLoop(): Promise<void> {
    let delay = backoffStartMs;
    while (!stopped && restarts < maxRestarts) {
      state = 'restarting';
      restarts += 1;
      nextRetryInMs = delay;
      // The backoff is abandoned the moment stop() lands, so a tear-down never waits out
      // a minute of it.
      await Promise.race([wait(delay), stoppedSignal]);
      if (stopped) return;
      try {
        await options.onBeforeRespawn?.();
      } catch {
        // A hook we could not delete is swept later; it must not stop the restart.
      }
      // onBeforeRespawn is several GitHub round trips long; an untrack, a merge or a
      // session ending inside it has already torn everything down.
      if (stopped) return;
      try {
        await launch();
        const handle = child;
        if (handle !== null) superviseExit(handle);
        await options.onConnected?.(restarts);
        return;
      } catch {
        log('warn', 'forwarder_restart_failed', { restarts, next_retry_ms: Math.min(delay * 2, backoffMaxMs) });
        delay = Math.min(delay * 2, backoffMaxMs);
      }
    }
    state = 'dead';
  }

  // The same sequence stop() uses: ask, then insist. Used by any path that abandons a
  // launch, so no gh ever escapes a tear-down.
  async function killHandle(handle: ChildHandle): Promise<void> {
    handle.kill('SIGTERM');
    const killed = await Promise.race([handle.exited.then(() => true), wait(2_000).then(() => false)]);
    if (!killed) handle.kill('SIGKILL');
  }

  return {
    get state() {
      return state;
    },
    get restarts() {
      return restarts;
    },
    get pid() {
      return child?.pid ?? null;
    },
    get processStart() {
      return currentStart;
    },
    get lastStderrLine() {
      return lastStderrLine;
    },
    get nextRetryInMs() {
      return state === 'restarting' ? nextRetryInMs : null;
    },
    async start() {
      state = 'starting';
      await launch();
      const handle = child;
      if (handle !== null) superviseExit(handle);
    },
    async stop() {
      stopped = true;
      releaseStopped();
      const handle = child;
      child = null;
      if (handle !== null) {
        handle.kill('SIGTERM');
        const killed = await Promise.race([
          handle.exited.then(() => true),
          wait(2_000).then(() => false),
        ]);
        if (!killed) handle.kill('SIGKILL');
      }
      // Returning while a restart is still mid-flight would let it spawn a gh, and a
      // hook, behind the tear-down that is deleting them.
      const cycle = restarting;
      if (cycle !== null) await cycle;
      state = 'dead';
    },
  };
}

// Bun's stderr is a byte stream; the connect line has to be recognised as it arrives, so
// it is read line by line rather than awaited whole.
export async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      yield buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
    // gh prints the connect line without a trailing newline until it flushes, so a
    // partial buffer that already contains it must still be seen.
    if (buffer.includes(CONNECT_LINE)) {
      yield buffer;
      buffer = '';
    }
  }
  if (buffer.length > 0) yield buffer;
}

export function spawnGhForwarder(cwd: string): SpawnForwarder {
  return (args, env) => {
    const child = Bun.spawn(['gh', ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdout: 'ignore',
      stderr: 'pipe',
      stdin: 'ignore',
    });
    return {
      pid: child.pid,
      stderrLines: lines(child.stderr as ReadableStream<Uint8Array>),
      exited: child.exited,
      kill: (signal) => child.kill(signal),
    };
  };
}
