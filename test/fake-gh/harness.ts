import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FAKE_GH_DIR = dirname(fileURLToPath(import.meta.url));

export interface FakeGh {
  readonly statePath: string;
  readonly logPath: string;
  readonly pathPrefix: string;
  state(): Record<string, unknown>;
  patch(changes: Record<string, unknown>): void;
  log(): string[][];
  env(): Record<string, string>;
}

// Puts the shim first on PATH for this process and every child it spawns, so `gh`
// anywhere in the code under test is the shim and never the real CLI.
export function fakeGhEnv(dir: string, initialState: Record<string, unknown> = {}): FakeGh {
  const statePath = join(dir, 'fake-gh-state.json');
  const logPath = join(dir, 'fake-gh.log');
  writeFileSync(statePath, JSON.stringify(initialState, null, 2));
  appendFileSync(logPath, '');

  // test/setup.ts already put the shim first on PATH; this only points it at a state file.
  process.env['FAKE_GH_STATE'] = statePath;
  process.env['FAKE_GH_LOG'] = logPath;

  const read = (): Record<string, unknown> => JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;

  return {
    statePath,
    logPath,
    pathPrefix: FAKE_GH_DIR,
    state: read,
    patch: (changes) => writeFileSync(statePath, JSON.stringify({ ...read(), ...changes }, null, 2)),
    log: () =>
      readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as string[]),
    env: () => ({
      FAKE_GH_STATE: statePath,
      FAKE_GH_LOG: logPath,
      FAKE_GH_BUN: process.execPath,
      PATH: process.env['PATH'] ?? '',
    }),
  };
}
