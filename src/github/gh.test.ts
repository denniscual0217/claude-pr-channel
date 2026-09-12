import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createGhClient, GhError } from './gh.js';
import { fakeGhEnv, type FakeGh } from '../../test/fake-gh/harness.js';

let dir: string;
let fake: FakeGh;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pr-channel-gh-'));
  fake = fakeGhEnv(dir, {
    login: 'octo-worker',
    pr: {
      number: 42,
      headRefOid: 'a'.repeat(40),
      state: 'OPEN',
      isDraft: false,
      url: 'https://github.com/Acme-Labs/Example/pull/42',
      headRefName: 'feature',
      baseRefName: 'main',
    },
    hooks: [
      { id: 11, name: 'cli', active: true, created_at: '2026-09-07T10:00:00Z' },
      { id: 12, name: 'web', active: true, created_at: '2026-09-07T10:00:00Z' },
    ],
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function client() {
  return createGhClient({ cwd: dir });
}

describe('GhClient', () => {
  it('reads the authenticated login', async () => {
    expect(await client().authLogin()).toBe('octo-worker');
  });

  it('reports an unauthenticated gh rather than guessing', async () => {
    fake.patch({ unauthenticated: true });
    await expect(client().authLogin()).rejects.toThrow(GhError);
  });

  it('sees the gh-webhook extension', async () => {
    expect(await client().extensionInstalled('webhook')).toBe(true);
    fake.patch({ webhookExtension: false });
    expect(await client().extensionInstalled('webhook')).toBe(false);
  });

  it('resolves a PR and normalizes its repo', async () => {
    expect(await client().prView('Acme-Labs/Example', 42)).toMatchObject({
      repo: 'acme-labs/example',
      number: 42,
      state: 'OPEN',
    });
    expect(await client().prForCurrentBranch()).toMatchObject({ repo: 'acme-labs/example', number: 42 });
  });

  // gh names every hook it creates "cli"; a hook a person added by hand is not ours.
  it('lists only the hooks gh created', async () => {
    expect((await client().listCliHooks('acme-labs/example')).map((hook) => hook.id)).toEqual([11]);
  });

  it('treats a 404 delete as already done and reports anything else', async () => {
    expect(await client().deleteHook('acme-labs/example', 11)).toBe('deleted');
    expect(await client().deleteHook('acme-labs/example', 11)).toBe('missing');
    fake.patch({ hooks: [{ id: 13, name: 'cli', active: true }], deleteFails: [13] });
    await expect(client().deleteHook('acme-labs/example', 13)).rejects.toThrow(GhError);
  });

  it('pings a hook and reports a hook that is gone as null', async () => {
    await client().pingHook('acme-labs/example', 11);
    expect(fake.state().pinged).toEqual([11]);
    expect(await client().hook('acme-labs/example', 11)).toMatchObject({ id: 11, active: true });
    expect(await client().hook('acme-labs/example', 999)).toBeNull();
  });

  it('never puts a token or a body in the argv it runs', async () => {
    await client().authLogin();
    await client().listCliHooks('acme-labs/example');
    expect(fake.log().flat().join(' ')).not.toMatch(/secret|token|ghp_/i);
  });
});

// Guards the guard: without FAKE_GH_STATE the shim must abort rather than let a test
// reach the real gh on this machine.
describe('the fake gh shim', () => {
  it('refuses to run unconfigured', async () => {
    writeFileSync(join(dir, 'noop'), '');
    const child = Bun.spawn(['gh', 'api', 'user'], {
      cwd: dir,
      env: { PATH: fake.pathPrefix + ':' + (process.env['PATH'] ?? '') },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    expect(await child.exited).toBe(99);
  });
});
