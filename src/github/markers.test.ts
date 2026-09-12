import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { fakeGhEnv, type FakeGh } from '../../test/fake-gh/harness.js';
import { createGhClient } from './gh.js';
import { janitorAlive, markerDir, readMarkers, sweep, writeMarker } from './markers.js';
import { processStart } from './ps.js';

const REPO = 'acme-labs/example';

let dir: string;
let cacheDir: string;
let fake: FakeGh;
const children: { kill(signal?: NodeJS.Signals): void }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pr-channel-markers-'));
  cacheDir = join(dir, 'cache');
  fake = fakeGhEnv(dir, {
    hooks: [
      { id: 11, name: 'cli', active: true },
      { id: 12, name: 'cli', active: true },
      { id: 13, name: 'web', active: true },
    ],
  });
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

function gh() {
  return createGhClient({ cwd: dir });
}

function janitorChild(repo: string): { pid: number; start: string | null; kill(signal?: NodeJS.Signals): void } {
  const script = join(import.meta.dir, 'janitor.ts');
  const child = Bun.spawn([process.execPath, script, repo], {
    cwd: dir,
    env: { ...process.env },
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  children.push(child);
  return { pid: child.pid, start: processStart(child.pid), kill: (signal) => child.kill(signal) };
}

function unrelatedChild(): { pid: number; start: string | null; kill(signal?: NodeJS.Signals): void } {
  const child = Bun.spawn(['sleep', '30'], { cwd: dir, stdout: 'ignore', stderr: 'ignore' });
  children.push(child);
  return { pid: child.pid, start: processStart(child.pid), kill: (signal) => child.kill(signal) };
}

describe('markers', () => {
  it('names the file after the repo and the hook, and moves it when the id is confirmed', () => {
    const handle = writeMarker({ repo: REPO, sessionId: 's1', cacheDir });
    expect(handle.path).toContain('acme-labs__example__pending-');
    handle.update({ hookId: 11 });
    expect(handle.path.endsWith('acme-labs__example__11.json')).toBe(true);
    expect(readdirSync(markerDir(cacheDir))).toEqual(['acme-labs__example__11.json']);
    expect(readMarkers(cacheDir)[0]?.marker).toMatchObject({ repo: REPO, hookId: 11, sessionId: 's1' });
    handle.remove();
    expect(readMarkers(cacheDir)).toEqual([]);
  });

  it('never records a secret', () => {
    const handle = writeMarker({ repo: REPO, sessionId: 's1', cacheDir });
    handle.update({ hookId: 11, ghPid: 999, ghStart: 'Mon Sep  7 10:00:00 2026' });
    expect(JSON.stringify(readMarkers(cacheDir))).not.toMatch(/secret|token/i);
  });
});

describe('janitorAlive', () => {
  it('is true only for a live process that really is a janitor for that repo', () => {
    const janitor = janitorChild(REPO);
    expect(janitorAlive({ repo: REPO, janitorPid: janitor.pid, janitorStart: janitor.start } as never)).toBe(true);
    // The same pid with a start time from another era is a reused pid, not our janitor.
    expect(janitorAlive({ repo: REPO, janitorPid: janitor.pid, janitorStart: 'Mon Jan  1 00:00:00 2001' } as never)).toBe(false);
    // A janitor for a different repo is another session's business.
    expect(janitorAlive({ repo: 'acme-labs/other', janitorPid: janitor.pid, janitorStart: janitor.start } as never)).toBe(false);
  });

  it('is false for a pid reused by something unrelated, and for a dead pid', () => {
    const other = unrelatedChild();
    expect(janitorAlive({ repo: REPO, janitorPid: other.pid, janitorStart: other.start } as never)).toBe(false);
    expect(janitorAlive({ repo: REPO, janitorPid: 2_147_483_646, janitorStart: null } as never)).toBe(false);
    expect(janitorAlive({ repo: REPO, janitorPid: null, janitorStart: null } as never)).toBe(false);
  });
});

describe('sweep', () => {
  it('deletes the hook a dead janitor left behind and removes its marker', async () => {
    const handle = writeMarker({ repo: REPO, sessionId: 's1', cacheDir });
    handle.update({ hookId: 11, janitorPid: 2_147_483_646, janitorStart: null });

    const result = await sweep(gh(), { onlyRepo: REPO, cacheDir });

    expect(result.deletedHooks).toEqual([11]);
    expect(fake.state()['deleted']).toEqual([11]);
    expect(readMarkers(cacheDir)).toEqual([]);
  });

  it('leaves a marker whose janitor is still alive completely alone', async () => {
    const janitor = janitorChild(REPO);
    const handle = writeMarker({ repo: REPO, sessionId: 's1', cacheDir });
    handle.update({ hookId: 11, janitorPid: janitor.pid, janitorStart: janitor.start });

    const result = await sweep(gh(), { onlyRepo: REPO, cacheDir });

    expect(result).toMatchObject({ deletedHooks: [], skippedLive: 1 });
    expect(fake.state()['deleted']).toBeUndefined();
    expect(readMarkers(cacheDir)).toHaveLength(1);
  });

  it('treats a pid reused by an unrelated process as a dead janitor', async () => {
    const other = unrelatedChild();
    const handle = writeMarker({ repo: REPO, sessionId: 's1', cacheDir });
    handle.update({ hookId: 11, janitorPid: other.pid, janitorStart: other.start });

    expect((await sweep(gh(), { onlyRepo: REPO, cacheDir })).deletedHooks).toEqual([11]);
  });

  // Hooks with no marker are what protect other machines, other sessions, and anything a
  // person created by hand. The sweep must never reach for one.
  it('never touches a hook that has no marker', async () => {
    const handle = writeMarker({ repo: REPO, sessionId: 's1', cacheDir });
    handle.update({ hookId: 11, janitorPid: 2_147_483_646, janitorStart: null });

    await sweep(gh(), { onlyRepo: REPO, cacheDir });

    const deletes = fake.log().filter((call) => call.includes('DELETE'));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.join(' ')).toContain('hooks/11');
    expect((fake.state()['hooks'] as { id: number }[]).map((hook) => hook.id)).toEqual([12, 13]);
  });

  it('counts a hook GitHub says is already gone as done', async () => {
    const handle = writeMarker({ repo: REPO, sessionId: 's1', cacheDir });
    handle.update({ hookId: 999, janitorPid: 2_147_483_646, janitorStart: null });

    const result = await sweep(gh(), { onlyRepo: REPO, cacheDir });

    expect(result.failures).toEqual([]);
    expect(readMarkers(cacheDir)).toEqual([]);
  });

  it('keeps the marker when the delete is refused, so the next sweep tries again', async () => {
    fake.patch({ deleteFails: [11] });
    const handle = writeMarker({ repo: REPO, sessionId: 's1', cacheDir });
    handle.update({ hookId: 11, janitorPid: 2_147_483_646, janitorStart: null });

    const result = await sweep(gh(), { onlyRepo: REPO, cacheDir });

    expect(result.failures).toHaveLength(1);
    expect(readMarkers(cacheDir)).toHaveLength(1);
  });

  // A DELETE that failed during a forwarder restart leaves a hook nothing else names.
  it('deletes the hooks a marker still has pending as well as the one it names', async () => {
    const handle = writeMarker({ repo: REPO, sessionId: 's1', cacheDir });
    handle.update({ hookId: 12, pendingHookIds: [11], janitorPid: 2_147_483_646, janitorStart: null });

    const result = await sweep(gh(), { onlyRepo: REPO, cacheDir });

    expect([...result.deletedHooks].sort()).toEqual([11, 12]);
    expect((fake.state()['hooks'] as { id: number }[]).map((hook) => hook.id)).toEqual([13]);
    expect(readMarkers(cacheDir)).toEqual([]);
  });

  // A restart that is still in flight when the tear-down finishes must not write the file
  // back: it would name hooks nothing is tracking any more.
  it('ignores an update that arrives after the marker was removed', () => {
    const handle = writeMarker({ repo: REPO, sessionId: 's1', cacheDir });
    handle.update({ hookId: 11 });
    handle.remove();

    handle.update({ hookId: null, pendingHookIds: [11] });

    expect(readMarkers(cacheDir)).toEqual([]);
  });

  it('leaves markers for other repositories alone', async () => {
    writeMarker({ repo: 'acme-labs/other', sessionId: 's1', cacheDir }).update({ hookId: 12, janitorPid: 2_147_483_646 });

    const result = await sweep(gh(), { onlyRepo: REPO, cacheDir });

    expect(result.deletedHooks).toEqual([]);
    expect(readMarkers(cacheDir)).toHaveLength(1);
  });

  it('kills a gh the marker names, but only when the pid and its start still match', async () => {
    const ghChild = unrelatedChild();
    const handle = writeMarker({ repo: REPO, sessionId: 's1', cacheDir });
    handle.update({ hookId: 11, janitorPid: 2_147_483_646, ghPid: ghChild.pid, ghStart: ghChild.start });
    const killed: number[] = [];

    await sweep(gh(), { onlyRepo: REPO, cacheDir, kill: (pid) => killed.push(pid) });
    expect(killed).toEqual([ghChild.pid]);

    const stale = writeMarker({ repo: REPO, sessionId: 's2', cacheDir });
    stale.update({ hookId: 12, janitorPid: 2_147_483_646, ghPid: ghChild.pid, ghStart: 'Mon Jan  1 00:00:00 2001' });
    const killedAgain: number[] = [];
    await sweep(gh(), { onlyRepo: REPO, cacheDir, kill: (pid) => killedAgain.push(pid) });
    expect(killedAgain).toEqual([]);
  });
});
