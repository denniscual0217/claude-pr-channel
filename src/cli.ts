import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULTS, ENV, normalizeRepo } from './config.js';
import { ChannelManager } from './channel/manager.js';
import { PrRegistry } from './registry/registry.js';
import { ChannelDb } from './store/db.js';
import type { PrRef, SessionRoute } from './types.js';

export const USAGE = `claude-pr-channel registration CLI

  register    --repo <owner/name> --pr <number> --session <id> [--head <sha>] [--dir <path>] [--replace]
  deregister  --repo <owner/name> --pr <number> --session <id>
  status      [--session <id>] [--repo <owner/name> --pr <number>]

Environment: ${ENV.dbPath} (default ${DEFAULTS.dbPath}), ${ENV.repoAllowlist} (enforced when set).
Registering binds one (repo, PR, session): the dispatcher pushes that PR's events into that session.`;

export interface CliIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: () => string;
  // Injected so tests do not shell out. Returns trimmed stdout, or null if git failed.
  readonly git?: (args: readonly string[], cwd: string) => string | null;
  readonly openDb?: (path: string) => ChannelDb;
}

export const EXIT = { ok: 0, refused: 1, usage: 2 } as const;

function runGit(io: CliIo, args: readonly string[], cwd: string): string | null {
  const git =
    io.git ??
    ((gitArgs: readonly string[], gitCwd: string): string | null => {
      try {
        return execFileSync('git', [...gitArgs], { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch {
        return null;
      }
    });
  return git(args, cwd);
}

function repoFromRemote(url: string): string | null {
  const match = /(?:[:/])([^/:]+\/[^/]+?)(?:\.git)?$/.exec(url.trim());
  return match?.[1] ? normalizeRepo(match[1]) : null;
}

// A worktree is just another directory, so registering the wrong one is easy and silent:
// the session would run in a checkout of a different branch, or a different project, and
// edit the wrong tree. Resolve to the worktree root and prove it belongs to this repo.
function resolveWorkerDir(io: CliIo, requested: string, repo: string): string {
  const start = resolve(requested);
  const top = runGit(io, ['rev-parse', '--show-toplevel'], start);
  if (top === null) {
    throw new UsageError(`--dir ${start} is not a git checkout; pass the worktree for this PR`);
  }
  const remote = runGit(io, ['remote', 'get-url', 'origin'], top);
  const found = remote === null ? null : repoFromRemote(remote);
  if (found !== null && found !== repo) {
    throw new UsageError(`--dir ${top} is a checkout of ${found}, not ${repo}`);
  }
  return top;
}

export function runCli(argv: readonly string[], io: CliIo): number {
  const [command, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    io.stdout(USAGE);
    return command === undefined ? EXIT.usage : EXIT.ok;
  }

  let flags: Flags;
  try {
    flags = parseFlags(rest);
  } catch (error) {
    return fail(io, error);
  }

  const dbPath = resolve((io.env[ENV.dbPath] ?? DEFAULTS.dbPath).trim() || DEFAULTS.dbPath);
  const db = (io.openDb ?? ChannelDb.open)(dbPath);
  try {
    switch (command) {
      case 'register':
        return register(db, flags, io);
      case 'deregister':
        return deregister(db, flags, io);
      case 'status':
        return status(db, flags, io);
      default:
        io.stderr(`unknown command "${command}"`);
        io.stderr(USAGE);
        return EXIT.usage;
    }
  } catch (error) {
    return fail(io, error);
  } finally {
    db.close();
  }
}

function register(db: ChannelDb, flags: Flags, io: CliIo): number {
  const prRef = requirePrRef(flags);
  const sessionId = requireSession(flags);
  assertAllowed(io.env, prRef.repo);
  const headSha = flags.head === undefined ? null : requireSha(flags.head);
  // Defaults to where the worker registered itself from. Resolved to the worktree root,
  // so registering from a subdirectory still runs the session at the top of the tree.
  const workerDir = resolveWorkerDir(io, flags.dir ?? io.cwd(), prRef.repo);

  const result = new PrRegistry(db).register({
    prRef,
    sessionId,
    headSha,
    workerDir,
    ...(flags.replace ? { replace: true } : {}),
  });
  if (!result.ok) {
    return emit(io, EXIT.refused, {
      command: 'register',
      ok: false,
      reason: 'conflict',
      detail: `PR is already routed to session ${result.existing.sessionId}; pass --replace to take it over`,
      route: describeRoute(result.existing),
    });
  }
  return emit(io, EXIT.ok, {
    command: 'register',
    ok: true,
    replacedSessionId: result.replaced?.sessionId ?? null,
    backfilled: result.backfilled,
    ignoredHeadSha: result.ignoredHeadSha,
    detail:
      result.ignoredHeadSha === null
        ? null
        : `--head was ignored: a pull_request delivery established head ${result.route.headSha} for this route; pass --replace to override`,
    route: describeRoute(result.route),
  });
}

// Deregistration closes the route rather than deleting it: routing stops immediately,
// and the session's channel process still observes the closure and exits once drained.
function deregister(db: ChannelDb, flags: Flags, io: CliIo): number {
  const prRef = requirePrRef(flags);
  const sessionId = requireSession(flags);

  const outcome = db.transaction(() => {
    const route = db.getRoute(prRef);
    if (!route) return { ok: false as const, reason: 'not_registered' as const, route: null };
    if (route.sessionId !== sessionId) {
      return { ok: false as const, reason: 'session_mismatch' as const, route };
    }
    if (route.closed) return { ok: true as const, reason: 'already_closed' as const, route };
    new ChannelManager(db).deregister(prRef, sessionId);
    return { ok: true as const, reason: 'closed' as const, route: db.getRoute(prRef) };
  });

  return emit(io, outcome.ok ? EXIT.ok : EXIT.refused, {
    command: 'deregister',
    ok: outcome.ok,
    reason: outcome.reason,
    route: outcome.route ? describeRoute(outcome.route) : null,
  });
}

function status(db: ChannelDb, flags: Flags, io: CliIo): number {
  if (flags.session !== undefined) {
    const channel = new ChannelManager(db).status(flags.session);
    return emit(io, EXIT.ok, {
      command: 'status',
      ok: true,
      sessionId: channel.sessionId,
      state: channel.state,
      drained: channel.drained,
      unacked: channel.unacked,
      queue: channel.queue,
      route: channel.route ? describeRoute(channel.route) : null,
    });
  }
  if (flags.repo !== undefined || flags.pr !== undefined) {
    const prRef = requirePrRef(flags);
    const route = db.getRoute(prRef);
    return emit(io, EXIT.ok, {
      command: 'status',
      ok: true,
      route: route ? describeRoute(route) : null,
      unacked: route ? db.countPending(route.sessionId) : 0,
      unrouted: db.countUnrouted(prRef),
    });
  }
  return emit(io, EXIT.ok, {
    command: 'status',
    ok: true,
    openRoutes: db.listOpenRoutes().map(describeRoute),
  });
}

interface Flags {
  readonly repo?: string;
  readonly pr?: string;
  readonly session?: string;
  readonly head?: string;
  readonly dir?: string;
  readonly replace: boolean;
}

class UsageError extends Error {
  override readonly name = 'UsageError';
}

function parseFlags(argv: readonly string[]): Flags {
  const values: Record<string, string> = {};
  let replace = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--replace') {
      replace = true;
      continue;
    }
    if (!token.startsWith('--')) throw new UsageError(`unexpected argument "${token}"`);
    const name = token.slice(2);
    if (!['repo', 'pr', 'session', 'head', 'dir'].includes(name)) throw new UsageError(`unknown flag "${token}"`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${token} requires a value`);
    values[name] = value;
    index += 1;
  }
  return {
    ...(values['repo'] !== undefined ? { repo: values['repo'] } : {}),
    ...(values['pr'] !== undefined ? { pr: values['pr'] } : {}),
    ...(values['session'] !== undefined ? { session: values['session'] } : {}),
    ...(values['head'] !== undefined ? { head: values['head'] } : {}),
    ...(values['dir'] !== undefined ? { dir: values['dir'] } : {}),
    replace,
  };
}

function requirePrRef(flags: Flags): PrRef {
  if (flags.repo === undefined) throw new UsageError('--repo <owner/name> is required');
  const repo = normalizeRepo(flags.repo);
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo)) throw new UsageError(`--repo "${flags.repo}" is not owner/name`);
  if (flags.pr === undefined) throw new UsageError('--pr <number> is required');
  const prNumber = Number(flags.pr);
  if (!Number.isInteger(prNumber) || prNumber < 1) throw new UsageError(`--pr "${flags.pr}" is not a positive integer`);
  return { repo, prNumber };
}

function requireSession(flags: Flags): string {
  const sessionId = flags.session?.trim() ?? '';
  if (sessionId.length === 0) throw new UsageError('--session <id> is required');
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(sessionId)) throw new UsageError('--session id has unsupported characters');
  return sessionId;
}

function requireSha(raw: string): string {
  if (!/^[0-9a-fA-F]{7,64}$/.test(raw)) throw new UsageError(`--head "${raw}" is not a commit sha`);
  return raw.toLowerCase();
}

function assertAllowed(env: CliIo['env'], repo: string): void {
  const raw = env[ENV.repoAllowlist];
  if (raw === undefined || raw.trim() === '') return;
  const allowed = new Set(raw.split(',').map(normalizeRepo).filter((entry) => entry.length > 0));
  if (!allowed.has(repo)) {
    throw new UsageError(`repo "${repo}" is not in ${ENV.repoAllowlist}; its events would never be delivered`);
  }
}

function describeRoute(route: SessionRoute): Record<string, unknown> {
  return {
    repo: route.prRef.repo,
    prNumber: route.prRef.prNumber,
    sessionId: route.sessionId,
    headSha: route.headSha,
    headSource: route.headSource,
    lifecycle: route.lifecycle,
    closed: route.closed,
    // Worth showing: with worktrees this is the one field that silently points a session
    // at the wrong checkout.
    workerDir: route.workerDir,
    registeredAtIso: route.registeredAtIso,
    updatedAtIso: route.updatedAtIso,
  };
}

function emit(io: CliIo, code: number, body: Record<string, unknown>): number {
  io.stdout(JSON.stringify(body));
  return code;
}

function fail(io: CliIo, error: unknown): number {
  io.stderr(error instanceof Error ? error.message : String(error));
  if (error instanceof UsageError) io.stderr(USAGE);
  return EXIT.usage;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(
    runCli(process.argv.slice(2), {
      cwd: () => process.cwd(),
      stdout: (line) => process.stdout.write(`${line}\n`),
      stderr: (line) => process.stderr.write(`${line}\n`),
      env: process.env,
    }),
  );
}
