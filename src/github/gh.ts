import { normalizeRepo } from '../events/repo.js';

export interface PrInfo {
  readonly repo: string;
  readonly number: number;
  readonly headRefOid: string | null;
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly isDraft: boolean;
  readonly url: string;
  readonly headRefName: string;
  readonly baseRefName: string;
}

export interface HookInfo {
  readonly id: number;
  readonly active: boolean;
  readonly createdAt: string | null;
}

export type DeleteHookResult = 'deleted' | 'missing';

export interface GhClient {
  authLogin(): Promise<string>;
  extensionInstalled(name: string): Promise<boolean>;
  prView(repo: string, prNumber: number): Promise<PrInfo>;
  prForCurrentBranch(): Promise<PrInfo>;
  listCliHooks(repo: string): Promise<readonly HookInfo[]>;
  pingHook(repo: string, hookId: number): Promise<void>;
  deleteHook(repo: string, hookId: number): Promise<DeleteHookResult>;
  hook(repo: string, hookId: number): Promise<HookInfo | null>;
}

export class GhError extends Error {
  override readonly name = 'GhError';
  readonly code: string;
  readonly stderrTail: string;

  constructor(code: string, message: string, stderrTail = '') {
    super(message);
    this.code = code;
    this.stderrTail = stderrTail;
  }
}

export interface RealGhOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

const PR_FIELDS = 'number,headRefOid,state,isDraft,url,headRefName,baseRefName';

export function createGhClient(options: RealGhOptions = {}): GhClient {
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function run(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    // env is passed explicitly: Bun resolves the binary from the PATH in these options,
    // not from a PATH mutated after the process started.
    const child = Bun.spawn(['gh', ...args], {
      cwd,
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  }

  async function json<T>(args: readonly string[], code: string): Promise<T> {
    const result = await run(args);
    if (result.code !== 0) throw new GhError(code, `gh ${args[0]} failed`, lastLine(result.stderr));
    try {
      return JSON.parse(result.stdout) as T;
    } catch {
      throw new GhError(code, `gh ${args[0]} returned output that is not JSON`);
    }
  }

  return {
    async authLogin(): Promise<string> {
      const result = await run(['api', 'user', '--jq', '.login']);
      if (result.code !== 0) {
        throw new GhError('gh_unauthenticated', 'gh is not authenticated', lastLine(result.stderr));
      }
      return result.stdout.trim();
    },

    async extensionInstalled(name: string): Promise<boolean> {
      const result = await run(['extension', 'list']);
      if (result.code !== 0) return false;
      return result.stdout.split('\n').some((line) => line.includes(`gh-${name}`) || line.includes(`/${name}`));
    },

    async prView(repo: string, prNumber: number): Promise<PrInfo> {
      const raw = await json<Omit<PrInfo, 'repo'>>(
        ['pr', 'view', String(prNumber), '--repo', repo, '--json', PR_FIELDS],
        'not_a_pr',
      );
      return { ...raw, repo: normalizeRepo(repo) };
    },

    async prForCurrentBranch(): Promise<PrInfo> {
      const raw = await json<Omit<PrInfo, 'repo'>>(['pr', 'view', '--json', PR_FIELDS], 'not_a_pr');
      return { ...raw, repo: repoFromUrl(raw.url) };
    },

    async listCliHooks(repo: string): Promise<readonly HookInfo[]> {
      const hooks = await json<{ id: number; name?: string; active?: boolean; created_at?: string }[]>(
        ['api', `repos/${repo}/hooks`, '--paginate'],
        'hook_list_failed',
      );
      return hooks
        .filter((hook) => hook.name === 'cli')
        .map((hook) => ({ id: hook.id, active: hook.active !== false, createdAt: hook.created_at ?? null }));
    },

    async pingHook(repo: string, hookId: number): Promise<void> {
      const result = await run(['api', '-X', 'POST', `repos/${repo}/hooks/${hookId}/pings`]);
      if (result.code !== 0) throw new GhError('hook_ping_failed', `ping of hook ${hookId} failed`, lastLine(result.stderr));
    },

    async deleteHook(repo: string, hookId: number): Promise<DeleteHookResult> {
      const result = await run(['api', '-X', 'DELETE', `repos/${repo}/hooks/${hookId}`]);
      if (result.code === 0) return 'deleted';
      // A hook that is already gone is the outcome we wanted, so 404 counts as done.
      if (/HTTP 404/.test(result.stderr)) return 'missing';
      throw new GhError('hook_delete_failed', `delete of hook ${hookId} failed`, lastLine(result.stderr));
    },

    async hook(repo: string, hookId: number): Promise<HookInfo | null> {
      const result = await run(['api', `repos/${repo}/hooks/${hookId}`]);
      if (result.code !== 0) return null;
      try {
        const parsed = JSON.parse(result.stdout) as { id: number; active?: boolean; created_at?: string };
        return { id: parsed.id, active: parsed.active !== false, createdAt: parsed.created_at ?? null };
      } catch {
        return null;
      }
    },
  };
}

function repoFromUrl(url: string): string {
  const match = /github\.com\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url);
  if (!match) throw new GhError('not_a_pr', `could not read a repository out of "${url}"`);
  return normalizeRepo(match[1] as string);
}

// gh puts the useful line last ("you do not have access to this feature" for a 403).
// Bodies are never logged, only this one line.
function lastLine(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  return lines[lines.length - 1] ?? '';
}
