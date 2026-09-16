import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'bun:test';
import { createEditor, loadOrCreateToken } from './server.ts';

const TOKEN = 'a'.repeat(64);
const PAGE = join(import.meta.dir, 'index.html');

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pr-channel-ui-'));
  dirs.push(dir);
  return dir;
}

function editor(overrides: { validate?: (text: string) => { ok: true } | { ok: false; message: string } } = {}) {
  const configPath = join(temp(), 'config.json');
  const handle = createEditor({
    configPath,
    token: TOKEN,
    page: PAGE,
    schema: () => ({ title: 'test schema' }),
    validate: overrides.validate ?? ((text) => (text.includes('nope') ? { ok: false, message: 'authors.mode: bad' } : { ok: true })),
  });
  const call = (method: string, path: string, init: RequestInit = {}) =>
    handle(new Request(`http://127.0.0.1:4319${path}`, { method, ...init }));
  const withToken = (method: string, path: string, init: RequestInit = {}) =>
    call(method, path, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${TOKEN}` } });
  return { configPath, call, withToken };
}

describe('the config editor', () => {
  it('serves the page without a token, so a bare URL explains itself', async () => {
    const reply = await editor().call('GET', '/');

    expect(reply.status).toBe(200);
    expect(await reply.text()).toContain('PR Channel configuration');
  });

  it('refuses to read the config, the schema or write the config without the token', async () => {
    const e = editor();

    expect((await e.call('GET', '/api/schema')).status).toBe(401);
    expect((await e.call('GET', '/api/config')).status).toBe(401);

    const put = await e.call('PUT', '/api/config', { body: JSON.stringify({ text: '{"version": 1}' }) });
    expect(put.status).toBe(401);
    expect(await Bun.file(e.configPath).exists()).toBe(false);
  });

  it('refuses a wrong token', async () => {
    const e = editor();
    const reply = await e.call('GET', '/api/config', { headers: { authorization: `Bearer ${'b'.repeat(64)}` } });

    expect(reply.status).toBe(401);
    // A token of the wrong length must be refused, not crash the comparison.
    expect((await e.call('GET', '/api/config', { headers: { authorization: 'Bearer short' } })).status).toBe(401);
  });

  it('saves with the token, at the same mode as the file the plugin reads', async () => {
    const e = editor();

    const put = await e.withToken('PUT', '/api/config', { body: JSON.stringify({ text: '{"version": 1}' }) });
    expect(put.status).toBe(200);
    expect(await readFile(e.configPath, 'utf8')).toBe('{"version": 1}\n');
    expect(statSync(e.configPath).mode & 0o777).toBe(0o600);

    const read = await e.withToken('GET', '/api/config');
    expect(await read.json()).toMatchObject({ exists: true, text: '{"version": 1}\n' });
  });

  it('still refuses a config the plugin would refuse', async () => {
    const e = editor();

    const reply = await e.withToken('PUT', '/api/config', { body: JSON.stringify({ text: '{"authors": "nope"}' }) });

    expect(reply.status).toBe(422);
    expect(await reply.json()).toMatchObject({ error: 'authors.mode: bad' });
    expect(await Bun.file(e.configPath).exists()).toBe(false);
  });

  it('creates the token once and reuses it on restart', async () => {
    const configPath = join(temp(), 'config.json');

    const first = loadOrCreateToken(configPath);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(loadOrCreateToken(configPath)).toBe(first);
    expect(statSync(join(configPath, '..', 'ui-token')).mode & 0o777).toBe(0o600);
  });
});
