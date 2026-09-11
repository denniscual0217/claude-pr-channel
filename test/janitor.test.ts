import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { fakeGhEnv, type FakeGh } from './fake-gh/harness.js';
import { processInfo, processStart } from '../src/github/ps.js';

const REPO = 'toptal/example';
const JANITOR = join(import.meta.dir, '..', 'src', 'github', 'janitor.ts');

let dir: string;
let fake: FakeGh;
const spawned: { kill(signal?: NodeJS.Signals): void }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pr-channel-janitor-'));
  fake = fakeGhEnv(dir, { hooks: [{ id: 11, name: 'cli', active: true }] });
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

function marker(): string {
  const path = join(dir, 'marker.json');
  writeFileSync(path, JSON.stringify({ repo: REPO, hookId: 11 }));
  return path;
}

// A stand-in for the channel: it spawns the janitor with a pipe exactly as the channel
// does, then can be SIGKILLed to mimic a channel that never runs its own cleanup.
function parentScript(markerPath: string, ghPid: number, ghStart: string | null, sendDone: boolean): string {
  const path = join(dir, 'parent.ts');
  writeFileSync(
    path,
    `const child = Bun.spawn([process.execPath, ${JSON.stringify(JANITOR)}, ${JSON.stringify(REPO)}], {
       env: { ...process.env },
       stdin: 'pipe',
       stdout: 'ignore',
       stderr: 'inherit',
     });
     child.stdin.write(JSON.stringify(${JSON.stringify({ repo: REPO, marker: markerPath, hookId: 11 })}) + '\\n');
     child.stdin.write(JSON.stringify({ ghPid: ${ghPid}, ghStart: ${JSON.stringify(ghStart)} }) + '\\n');
     ${sendDone ? "child.stdin.write(JSON.stringify({ done: true }) + '\\n');" : ''}
     child.stdin.flush();
     process.stdout.write(String(child.pid));
     await new Promise(() => {});`,
  );
  return path;
}

async function startParent(options: { sendDone?: boolean; ghPid?: number; ghStart?: string | null } = {}): Promise<{
  parent: { pid: number; kill(signal?: NodeJS.Signals): void };
  janitorPid: number;
  markerPath: string;
}> {
  const markerPath = marker();
  const ghChild = Bun.spawn(['sleep', '60'], { cwd: dir, stdout: 'ignore', stderr: 'ignore' });
  spawned.push(ghChild);
  const ghPid = options.ghPid ?? ghChild.pid;
  const ghStart = options.ghStart === undefined ? processStart(ghChild.pid) : options.ghStart;

  const parent = Bun.spawn([process.execPath, parentScript(markerPath, ghPid, ghStart, options.sendDone === true)], {
    cwd: dir,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  spawned.push(parent);
  const janitorPid = Number(await readSome(parent.stdout));
  await until(() => processInfo(janitorPid) !== null);
  return { parent: { pid: parent.pid, kill: (signal) => parent.kill(signal) }, janitorPid, markerPath };
}

async function readSome(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return new TextDecoder().decode(value ?? new Uint8Array());
}

async function until(condition: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await Bun.sleep(50);
  }
  return condition();
}

const hookGone = (): boolean => ((fake.state()['hooks'] as unknown[]) ?? []).length === 0;

describe('the janitor', () => {
  it('deletes the hook, kills gh and removes the marker when its parent is SIGKILLed', async () => {
    const { parent, janitorPid, markerPath } = await startParent();
    const ghPid = spawned.find((child) => 'pid' in child)?.pid;

    parent.kill('SIGKILL');

    expect(await until(hookGone)).toBe(true);
    expect(await until(() => !existsSync(markerPath))).toBe(true);
    expect(await until(() => processInfo(janitorPid) === null)).toBe(true);
    if (typeof ghPid === 'number') expect(await until(() => processInfo(ghPid) === null)).toBe(true);
  }, 20_000);

  it('cleans up on stdin EOF even while its parent lives on', async () => {
    const markerPath = marker();
    const child = Bun.spawn([process.execPath, JANITOR, REPO], {
      cwd: dir,
      env: { ...process.env },
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'inherit',
    });
    spawned.push(child);
    child.stdin.write(`${JSON.stringify({ repo: REPO, marker: markerPath, hookId: 11 })}\n`);
    child.stdin.flush();
    await Bun.sleep(200);

    child.stdin.end();

    expect(await until(hookGone)).toBe(true);
    expect(await until(() => !existsSync(markerPath))).toBe(true);
    expect(await child.exited).toBe(0);
  }, 20_000);

  it('exits without touching anything once told the work is done', async () => {
    const markerPath = marker();
    const child = Bun.spawn([process.execPath, JANITOR, REPO], {
      cwd: dir,
      env: { ...process.env },
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'inherit',
    });
    spawned.push(child);
    child.stdin.write(`${JSON.stringify({ repo: REPO, marker: markerPath, hookId: 11 })}\n`);
    child.stdin.write(`${JSON.stringify({ done: true })}\n`);
    child.stdin.flush();
    await Bun.sleep(200);

    child.stdin.end();

    expect(await child.exited).toBe(0);
    expect(hookGone()).toBe(false);
    expect(fake.log().some((call) => call.includes('DELETE'))).toBe(false);
  }, 20_000);

  // tmux kill-session delivers SIGHUP to the whole pane group; the janitor must outlive
  // it and finish its cleanup on its own terms.
  it('ignores SIGHUP and still cleans up when its pipe closes', async () => {
    const markerPath = marker();
    const child = Bun.spawn([process.execPath, JANITOR, REPO], {
      cwd: dir,
      env: { ...process.env },
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'inherit',
    });
    spawned.push(child);
    child.stdin.write(`${JSON.stringify({ repo: REPO, marker: markerPath, hookId: 11 })}\n`);
    child.stdin.flush();
    await Bun.sleep(300);

    child.kill('SIGHUP');
    await Bun.sleep(300);
    expect(processInfo(child.pid)).not.toBeNull();
    expect(hookGone()).toBe(false);

    child.stdin.end();
    expect(await until(hookGone)).toBe(true);
    expect(await child.exited).toBe(0);
  }, 20_000);

  it('never kills a gh pid whose start time no longer matches', async () => {
    const ghChild = Bun.spawn(['sleep', '60'], { cwd: dir, stdout: 'ignore', stderr: 'ignore' });
    spawned.push(ghChild);
    const markerPath = marker();
    const child = Bun.spawn([process.execPath, JANITOR, REPO], {
      cwd: dir,
      env: { ...process.env },
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'inherit',
    });
    spawned.push(child);
    child.stdin.write(`${JSON.stringify({ repo: REPO, marker: markerPath, hookId: 11 })}\n`);
    child.stdin.write(`${JSON.stringify({ ghPid: ghChild.pid, ghStart: 'Mon Jan  1 00:00:00 2001' })}\n`);
    child.stdin.flush();
    await Bun.sleep(200);

    child.stdin.end();

    expect(await until(hookGone)).toBe(true);
    expect(await child.exited).toBe(0);
    // The pid belongs to something else now, so it is left running.
    expect(processInfo(ghChild.pid)).not.toBeNull();
  }, 20_000);
});
