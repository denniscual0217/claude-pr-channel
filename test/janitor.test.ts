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
function parentScript(messages: readonly Record<string, unknown>[]): string {
  const path = join(dir, 'parent.ts');
  writeFileSync(
    path,
    `const child = Bun.spawn([process.execPath, ${JSON.stringify(JANITOR)}, ${JSON.stringify(REPO)}], {
       env: { ...process.env },
       stdin: 'pipe',
       stdout: 'ignore',
       stderr: 'inherit',
     });
     for (const message of ${JSON.stringify(messages)}) child.stdin.write(JSON.stringify(message) + '\\n');
     child.stdin.flush();
     process.stdout.write(String(child.pid));
     await new Promise(() => {});`,
  );
  return path;
}

interface StartParentOptions {
  sendDone?: boolean;
  ghPid?: number;
  ghStart?: string | null;
  messages?: readonly Record<string, unknown>[];
  // Closes the read end of the pipe the janitor logs to, as Claude Code's exit does.
  closeStderr?: boolean;
}

async function startParent(options: StartParentOptions = {}): Promise<{
  parent: { pid: number; kill(signal?: NodeJS.Signals): void };
  janitorPid: number;
  markerPath: string;
}> {
  const markerPath = marker();
  const ghChild = Bun.spawn(['sleep', '60'], { cwd: dir, stdout: 'ignore', stderr: 'ignore' });
  spawned.push(ghChild);
  const ghPid = options.ghPid ?? ghChild.pid;
  const ghStart = options.ghStart === undefined ? processStart(ghChild.pid) : options.ghStart;
  const messages: Record<string, unknown>[] = [
    ...(options.messages ?? [{ repo: REPO, marker: markerPath, hookId: 11 }]),
    { ghPid, ghStart },
    ...(options.sendDone === true ? [{ done: true }] : []),
  ];

  const parent = Bun.spawn([process.execPath, parentScript(messages)], {
    cwd: dir,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: options.closeStderr === true ? 'pipe' : 'inherit',
  });
  spawned.push(parent);
  const janitorPid = Number(await readSome(parent.stdout));
  await until(() => processInfo(janitorPid) !== null);
  if (options.closeStderr === true) await (parent.stderr as ReadableStream<Uint8Array>).cancel();
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

const hookGone = (): boolean => hookIds().length === 0;
const hookIds = (): number[] => (((fake.state()['hooks'] as { id: number }[]) ?? []).map((hook) => hook.id));

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

  // Claude Code owns the pipe both the channel and the janitor log to. When the session
  // is gone that pipe is closed, and a log line that kills the janitor kills the cleanup
  // with it: the webhook stays on the repository.
  it('still cleans up when the pipe it logs to is already closed', async () => {
    const { parent, janitorPid, markerPath } = await startParent({ closeStderr: true });

    parent.kill('SIGKILL');

    expect(await until(hookGone)).toBe(true);
    expect(await until(() => !existsSync(markerPath))).toBe(true);
    expect(await until(() => processInfo(janitorPid) === null)).toBe(true);
  }, 20_000);

  // tmux kill-session delivers SIGHUP to the pane group, and Claude Code's end of the log
  // pipe is already gone by then: neither may cost the janitor its cleanup.
  it('survives SIGHUP with its log pipe closed and still cleans up', async () => {
    const markerPath = marker();
    const child = Bun.spawn([process.execPath, JANITOR, REPO], {
      cwd: dir,
      env: { ...process.env },
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'pipe',
    });
    spawned.push(child);
    child.stdin.write(`${JSON.stringify({ repo: REPO, marker: markerPath, hookId: 11 })}\n`);
    child.stdin.flush();
    await Bun.sleep(200);
    await (child.stderr as ReadableStream<Uint8Array>).cancel();

    child.kill('SIGHUP');
    await Bun.sleep(200);
    child.stdin.end();

    expect(await until(hookGone)).toBe(true);
    expect(await until(() => !existsSync(markerPath))).toBe(true);
    expect(await child.exited).toBe(0);
  }, 20_000);

  // gh creates its hook before it connects, so a channel that died in that window never
  // sent a hook id. The janitor has no listener and so can never receive the signed ping
  // that proves a hook is ours — and on a repo where another session tracks a different
  // PR, the unfamiliar hook is more likely theirs than a leak of ours. Leaking one is
  // recoverable; silently stopping their events is not.
  it('deletes nothing when no hook id was confirmed: it has no listener, so it can never hold proof', async () => {
    fake.patch({ hooks: [{ id: 11, name: 'cli', active: true }, { id: 12, name: 'cli', active: true }] });
    const markerPath = join(dir, 'marker.json');
    const { parent } = await startParent({
      messages: [{ repo: REPO, marker: markerPath, hookId: null, snapshot: [11] }],
    });

    parent.kill('SIGKILL');

    expect(await until(() => !existsSync(markerPath))).toBe(true);
    expect(hookIds().join(',')).toBe('11,12');
  }, 20_000);

  it('deletes nothing when more than one hook appeared since the snapshot', async () => {
    fake.patch({
      hooks: [
        { id: 11, name: 'cli', active: true },
        { id: 12, name: 'cli', active: true },
        { id: 13, name: 'cli', active: true },
      ],
    });
    const { parent, janitorPid } = await startParent({
      messages: [{ repo: REPO, marker: join(dir, 'marker.json'), hookId: null, snapshot: [11] }],
    });

    parent.kill('SIGKILL');

    // One of 12 and 13 may be another live session's, and there is no way to tell which.
    expect(await until(() => processInfo(janitorPid) === null)).toBe(true);
    expect(hookIds()).toEqual([11, 12, 13]);
    expect(fake.log().some((call) => call.includes('DELETE'))).toBe(false);
  }, 20_000);

  // A DELETE the channel could not complete during a forwarder restart is ours by proof,
  // so it goes whatever else is on the repository — and the ambiguous strays still do not.
  it('deletes the hooks it was told are still pending, and only those', async () => {
    fake.patch({
      hooks: [
        { id: 11, name: 'cli', active: true },
        { id: 12, name: 'cli', active: true },
        { id: 13, name: 'cli', active: true },
      ],
    });
    const markerPath = join(dir, 'marker.json');
    const { parent } = await startParent({
      messages: [{ repo: REPO, marker: markerPath, hookId: null, snapshot: [11], pendingDeletes: [12] }],
    });

    parent.kill('SIGKILL');

    // 12 is ours by proof; 13 appeared since the snapshot and may be another session's.
    expect(await until(() => hookIds().join(',') === '11,13')).toBe(true);
    expect(await until(() => !existsSync(markerPath))).toBe(true);
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
