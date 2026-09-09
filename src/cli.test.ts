import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT, runCli, type CliIo } from './cli.js';
import { ENV } from './config.js';
import { ChannelDb } from './store/db.js';
import type { PrRef } from './types.js';

const REPO = 'acme-labs/widget-service';
const PR: PrRef = { repo: REPO, prNumber: 42 };
const SHA = 'c'.repeat(40);

let dir: string;
let env: Record<string, string | undefined>;

interface Run {
  readonly code: number;
  readonly out: Record<string, unknown>;
  readonly err: string;
}

function cli(...argv: string[]): Run {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli(argv, {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    cwd: () => '/tmp/worker-checkout',
    // Neutral by default: a checkout whose remote cannot be read is allowed through,
    // so these cases exercise registration rather than worktree validation.
    git: (args, cwd) => (args[0] === 'rev-parse' ? cwd : null),
    env,
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(out[0] ?? '{}') as Record<string, unknown>;
  } catch {
    parsed = { raw: out.join('\n') };
  }
  return { code, out: parsed, err: err.join('\n') };
}

function withDb<T>(fn: (db: ChannelDb) => T): T {
  const db = ChannelDb.open(env[ENV.dbPath]!);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pr-channel-cli-'));
  env = { [ENV.dbPath]: join(dir, 'channel.db') };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('register', () => {
  it('routes a PR to a session and reports the route', () => {
    const run = cli('register', '--repo', 'Acme-Labs/Widget-Service', '--pr', '42', '--session', 's-1', '--head', SHA);

    expect(run.code).toBe(EXIT.ok);
    expect(run.out).toMatchObject({ command: 'register', ok: true, replacedSessionId: null });
    expect(run.out['route']).toMatchObject({ repo: REPO, prNumber: 42, sessionId: 's-1', headSha: SHA, closed: false });
    expect(withDb((db) => db.getRoute(PR)?.sessionId)).toBe('s-1');
  });

  it('refuses a PR another session already holds unless --replace is given', () => {
    cli('register', '--repo', REPO, '--pr', '42', '--session', 's-1');

    const conflict = cli('register', '--repo', REPO, '--pr', '42', '--session', 's-2');
    expect(conflict.code).toBe(EXIT.refused);
    expect(conflict.out).toMatchObject({ ok: false, reason: 'conflict' });
    expect(withDb((db) => db.getRoute(PR)?.sessionId)).toBe('s-1');

    const takeover = cli('register', '--repo', REPO, '--pr', '42', '--session', 's-2', '--replace');
    expect(takeover.code).toBe(EXIT.ok);
    expect(takeover.out).toMatchObject({ ok: true, replacedSessionId: 's-1' });
  });

  it('rejects a repo outside the allowlist when one is configured', () => {
    env[ENV.repoAllowlist] = 'acme-labs/other-service';
    const run = cli('register', '--repo', REPO, '--pr', '42', '--session', 's-1');

    expect(run.code).toBe(EXIT.usage);
    expect(run.err).toContain(ENV.repoAllowlist);
    expect(withDb((db) => db.getRoute(PR))).toBeNull();
  });

  it('reports usage errors without touching the registry', () => {
    expect(cli('register', '--repo', 'not-a-repo', '--pr', '42', '--session', 's-1').code).toBe(EXIT.usage);
    expect(cli('register', '--repo', REPO, '--pr', '0', '--session', 's-1').code).toBe(EXIT.usage);
    expect(cli('register', '--repo', REPO, '--pr', '42').code).toBe(EXIT.usage);
    expect(cli('register', '--repo', REPO, '--pr', '42', '--session', 's-1', '--nope', 'x').code).toBe(EXIT.usage);
    expect(cli('register', '--repo', REPO, '--pr', '42', '--session', 's-1', '--head', 'nope').code).toBe(EXIT.usage);
    expect(withDb((db) => db.listOpenRoutes())).toEqual([]);
  });
});

describe('deregister', () => {
  it('closes the route so the channel drains and exits', () => {
    cli('register', '--repo', REPO, '--pr', '42', '--session', 's-1');

    const run = cli('deregister', '--repo', REPO, '--pr', '42', '--session', 's-1');
    expect(run.code).toBe(EXIT.ok);
    expect(run.out).toMatchObject({ ok: true, reason: 'closed' });
    expect(run.out['route']).toMatchObject({ closed: true });
    expect(withDb((db) => db.findOpenRoute(PR))).toBeNull();
  });

  it('refuses to close a route another session holds', () => {
    cli('register', '--repo', REPO, '--pr', '42', '--session', 's-1');

    const run = cli('deregister', '--repo', REPO, '--pr', '42', '--session', 's-2');
    expect(run.code).toBe(EXIT.refused);
    expect(run.out).toMatchObject({ ok: false, reason: 'session_mismatch' });
    expect(withDb((db) => db.findOpenRoute(PR)?.sessionId)).toBe('s-1');
  });

  it('reports an unknown route', () => {
    const run = cli('deregister', '--repo', REPO, '--pr', '9', '--session', 's-1');
    expect(run.code).toBe(EXIT.refused);
    expect(run.out).toMatchObject({ ok: false, reason: 'not_registered', route: null });
  });
});

describe('status', () => {
  it('reports a session channel, a single PR, and the open route list', () => {
    cli('register', '--repo', REPO, '--pr', '42', '--session', 's-1', '--head', SHA);

    const bySession = cli('status', '--session', 's-1');
    expect(bySession.out).toMatchObject({ state: 'active', unacked: 0, drained: false });
    expect(bySession.out['route']).toMatchObject({ prNumber: 42, headSha: SHA });

    const byPr = cli('status', '--repo', REPO, '--pr', '42');
    expect(byPr.out).toMatchObject({ unacked: 0, unrouted: 0 });

    const all = cli('status');
    expect(all.out['openRoutes']).toHaveLength(1);
    expect(all.code).toBe(EXIT.ok);
  });

  it('reports an unregistered session rather than failing', () => {
    const run = cli('status', '--session', 'never-registered');
    expect(run.code).toBe(EXIT.ok);
    expect(run.out).toMatchObject({ state: 'unregistered', route: null });
  });
});

describe('usage', () => {
  it('prints usage for help and for an unknown command', () => {
    const help = cli('help');
    expect(help.code).toBe(EXIT.ok);
    expect(String(help.out['raw'])).toContain('register');

    const unknown = cli('frobnicate');
    expect(unknown.code).toBe(EXIT.usage);
    expect(unknown.err).toContain('unknown command');
  });
});

describe('worktree validation', () => {
  function cliIn(git: CliIo['git'], ...argv: string[]): Run {
    const out: string[] = [];
    const err: string[] = [];
    const code = runCli(argv, {
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      cwd: () => '/tmp/worker-checkout',
      git,
      env,
    });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(out[0] ?? '{}') as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    return { code, out: parsed, err: err.join('\n') };
  }

  const gitFor = (repo: string | null): CliIo['git'] =>
    (args, cwd) => {
      if (args[0] === 'rev-parse') return cwd.startsWith('/tmp/not-a-repo') ? null : '/tmp/worker-checkout';
      if (args[0] === 'remote') return repo === null ? null : `git@github.com:${repo}.git`;
      return null;
    };

  // Worktrees make it easy to register the wrong directory: several checkouts of one
  // repo, each on a different branch. The session would edit the wrong tree silently.
  it('resolves a subdirectory to the worktree root', () => {
    const run = cliIn(gitFor(REPO), 'register', '--repo', REPO, '--pr', '7', '--session', 's1',
      '--dir', '/tmp/worker-checkout/src/deep');

    expect(run.code).toBe(EXIT.ok);
    expect(run.out['route']).toMatchObject({ prNumber: 7, workerDir: '/tmp/worker-checkout' });
  });

  it('refuses a directory that is not a git checkout', () => {
    const run = cliIn(gitFor(REPO), 'register', '--repo', REPO, '--pr', '7', '--session', 's1',
      '--dir', '/tmp/not-a-repo');

    expect(run.code).toBe(EXIT.usage);
    expect(run.err).toContain('not a git checkout');
  });

  it('refuses a checkout of a different repository', () => {
    const run = cliIn(gitFor('toptal/other-project'), 'register', '--repo', REPO, '--pr', '7',
      '--session', 's1', '--dir', '/tmp/worker-checkout');

    expect(run.code).toBe(EXIT.usage);
    expect(run.err).toContain('is a checkout of toptal/other-project');
  });
});
