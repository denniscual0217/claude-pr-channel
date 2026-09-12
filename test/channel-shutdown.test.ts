import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { fakeGhEnv, FAKE_GH_DIR, type FakeGh } from './fake-gh/harness.js';
import { FIXTURE_REPO, FIXTURE_HEAD_SHA } from './fixtures/index.js';

// The channel end to end, over MCP stdio, against the gh shim: the only place the real
// shutdown path — stdin EOF and signals — is exercised in the process it belongs to.

const SERVER = join(import.meta.dir, '..', 'server.ts');

let dir: string;
let configPath: string;
let fake: FakeGh;
const spawned: { kill(signal?: NodeJS.Signals): void }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pr-channel-e2e-'));
  configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({ authors: { mode: 'listed', allow: ['octo-worker'] }, cache: { dir } }),
    'utf8',
  );
  fake = fakeGhEnv(dir, {
    login: 'octo-worker',
    hooks: [{ id: 7, name: 'cli', active: true }],
    nextHookId: 100,
    pr: {
      number: 42,
      headRefOid: FIXTURE_HEAD_SHA,
      state: 'OPEN',
      isDraft: false,
      url: `https://github.com/${FIXTURE_REPO}/pull/42`,
      headRefName: 'feature/widget-cache',
      baseRefName: 'main',
    },
  });
});

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

interface Channel {
  readonly exited: Promise<number>;
  call(id: number, name: string, args: Record<string, unknown>): Promise<string>;
  awaitLog(match: string): Promise<string>;
  closeStderr(): Promise<void>;
  closeStdin(): void;
  kill(signal: NodeJS.Signals): void;
}

function startChannel(extraEnv: Record<string, string> = {}): Channel {
  const child = Bun.spawn([process.execPath, SERVER], {
    cwd: dir,
    env: {
      ...fake.env(),
      // The shim first, then the bun running this suite: the channel spawns `bun` for the
      // janitor and `gh` for everything else.
      PATH: `${FAKE_GH_DIR}:${dirname(process.execPath)}:${process.env['PATH'] ?? ''}`,
      HOME: dir,
      PR_CHANNEL_CONFIG: configPath,
      CLAUDE_PROJECT_DIR: dir,
      CLAUDE_CODE_SESSION_ID: 'session-e2e',
      ...extraEnv,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  spawned.push(child);
  const stdin = child.stdin as import('bun').FileSink;
  const stderr = child.stderr as ReadableStream<Uint8Array>;
  const messages = readMessages(child.stdout as ReadableStream<Uint8Array>);

  const send = (message: Record<string, unknown>): void => {
    stdin.write(`${JSON.stringify(message)}\n`);
    stdin.flush();
  };

  const response = async (id: number): Promise<Record<string, unknown>> => {
    for (;;) {
      const message = await messages.next();
      if (message.done === true) throw new Error(`the channel closed before answering ${id}`);
      if (message.value['id'] === id) return message.value;
    }
  };

  // Only one consumer may read the pipe, so a test either watches the log or cancels it.
  const awaitLog = async (match: string): Promise<string> => {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of stderr as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const line = buffer.split('\n').find((candidate) => candidate.includes(match));
      if (line !== undefined) return line;
    }
    throw new Error(`the channel never logged ${match}`);
  };

  return {
    exited: child.exited,
    awaitLog,
    closeStderr: () => stderr.cancel(),
    closeStdin: () => {
      stdin.end();
    },
    kill: (signal) => child.kill(signal),
    call: async (id, name, args) => {
      if (id === 1) {
        send({
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'e2e', version: '1.0.0' },
          },
        });
        await response(0);
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      }
      send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
      const answer = await response(id);
      const result = answer['result'] as { content?: { text?: string }[] } | undefined;
      return result?.content?.[0]?.text ?? JSON.stringify(answer);
    },
  };
}

async function* readMessages(stream: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) yield JSON.parse(line) as Record<string, unknown>;
      index = buffer.indexOf('\n');
    }
  }
}

const hookIds = (): number[] => ((fake.state()['hooks'] as { id: number }[]) ?? []).map((hook) => hook.id);
const markers = (): string[] => {
  try {
    return readdirSync(join(dir, 'hooks'));
  } catch {
    return [];
  }
};

describe('the channel process', () => {
  it('tracks a PR over MCP stdio and deletes the webhook when its stdin closes', async () => {
    const channel = startChannel();

    expect(await channel.call(1, 'track', { pr: '42', repo: FIXTURE_REPO })).toContain('hook: 100');
    expect(hookIds()).toEqual([7, 100]);

    channel.closeStdin();

    expect(await channel.exited).toBe(0);
    expect(hookIds()).toEqual([7]);
    expect(markers()).toEqual([]);
  }, 40_000);

  // Claude Code owns the other end of stdout and stderr, and when the session dies they
  // close in the same instant as stdin. A log line written to that closed pipe used to end
  // this process before shutdown could delete anything.
  it('deletes the webhook even when the pipes it logs to are already closed', async () => {
    const channel = startChannel();

    expect(await channel.call(1, 'track', { pr: '42', repo: FIXTURE_REPO })).toContain('hook: 100');

    await channel.closeStderr();
    channel.closeStdin();

    expect(await channel.exited).toBe(0);
    expect(hookIds()).toEqual([7]);
    expect(markers()).toEqual([]);
  }, 40_000);

  it('deletes the webhook on SIGTERM with its pipes already closed', async () => {
    const channel = startChannel();

    expect(await channel.call(1, 'track', { pr: '42', repo: FIXTURE_REPO })).toContain('hook: 100');

    await channel.closeStderr();
    channel.kill('SIGTERM');

    expect(await channel.exited).toBe(0);
    expect(hookIds()).toEqual([7]);
    expect(markers()).toEqual([]);
  }, 40_000);
});

describe('the config file', () => {
  it('says at startup which file it read', async () => {
    const channel = startChannel();

    const line = await channel.awaitLog('config_loaded');

    expect(JSON.parse(line)).toMatchObject({ event: 'config_loaded', path: configPath, source: 'file' });
    channel.closeStdin();
    expect(await channel.exited).toBe(0);
  }, 40_000);

  // The variable is gone as a value: a forgotten export in a shell profile must not
  // quietly outrank the file a UI wrote.
  it('refuses to track while a variable it no longer reads is set', async () => {
    const channel = startChannel({ PR_CHANNEL_CI_EVENTS: 'all' });

    const text = await channel.call(1, 'track', { pr: '42', repo: FIXTURE_REPO });

    expect(text).toStartWith('config_invalid: PR_CHANNEL_CI_EVENTS is no longer read; set events.checks.wake in');
    expect(hookIds()).toEqual([7]);

    await channel.closeStderr();
    channel.closeStdin();
    expect(await channel.exited).toBe(0);
  }, 40_000);
});
