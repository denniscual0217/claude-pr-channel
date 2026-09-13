// A local editor for the configuration file. There is no auth: anyone with a shell here
// can already edit the file directly, so the server grants nothing the filesystem does
// not — which is also why it binds loopback unless told otherwise. This file decides who
// may drive an agent that pushes code, so widen the bind only to an address that is
// already access-controlled, such as a VPN interface. PR_CHANNEL_UI_HOST refuses the
// wildcard addresses for that reason: on a box with a public interface they would put
// this editor on the internet.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { configJsonSchema } from '../src/config-schema.ts';
import { CONFIG_PATH_ENV, configPath, loadConfig } from '../src/config.ts';

const WILDCARD = new Set(['0.0.0.0', '::', '[::]', '*']);

function host(env: NodeJS.ProcessEnv): string {
  const requested = (env['PR_CHANNEL_UI_HOST'] ?? '').trim();
  if (requested === '') return '127.0.0.1';
  if (WILDCARD.has(requested)) {
    process.stderr.write(
      `PR_CHANNEL_UI_HOST=${requested} would serve the editor on every interface, including any public one.\n` +
        `Name the single address to listen on instead, such as this machine's VPN address.\n`,
    );
    process.exit(1);
  }
  return requested;
}

const HOST = host(process.env);
const PORT = Number(process.env['PR_CHANNEL_UI_PORT'] ?? 4319);
const PATH_TO_CONFIG = configPath(process.env);
const PAGE = join(import.meta.dir, 'index.html');

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

async function readCurrent(): Promise<{ text: string; exists: boolean }> {
  try {
    return { text: await readFile(PATH_TO_CONFIG, 'utf8'), exists: true };
  } catch {
    return { text: '{}\n', exists: false };
  }
}

// Validated by the same loader the plugin uses, against the text about to be written —
// a second implementation here could accept what the plugin then refuses at startup.
function validate(text: string): { ok: true } | { ok: false; message: string } {
  const probe = `${PATH_TO_CONFIG}.ui-check`;
  const result = loadConfig({
    env: { ...process.env, [CONFIG_PATH_ENV]: probe },
    readFile: (path: string) => (path === probe ? text : (() => { throw new Error('ENOENT'); })()),
  });
  return result.ok ? { ok: true } : { ok: false, message: result.error.message };
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(Bun.file(PAGE), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (request.method === 'GET' && url.pathname === '/api/schema') {
      return json(configJsonSchema());
    }
    if (request.method === 'GET' && url.pathname === '/api/config') {
      const { text, exists } = await readCurrent();
      return json({ path: PATH_TO_CONFIG, exists, text });
    }
    if (request.method === 'PUT' && url.pathname === '/api/config') {
      const body = (await request.json().catch(() => null)) as { text?: string } | null;
      const text = typeof body?.text === 'string' ? body.text : null;
      if (text === null) return json({ error: 'expected { "text": "<file contents>" }' }, 400);

      const checked = validate(text);
      if (!checked.ok) return json({ error: checked.message }, 422);

      // Written through a temporary file: a crash mid-write leaves the old config intact
      // rather than a truncated one the plugin would refuse at next launch.
      await mkdir(dirname(PATH_TO_CONFIG), { recursive: true });
      const temporary = `${PATH_TO_CONFIG}.tmp-${process.pid}`;
      await writeFile(temporary, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 });
      await rename(temporary, PATH_TO_CONFIG);
      return json({ path: PATH_TO_CONFIG, saved: true });
    }
    return new Response('not found', { status: 404 });
  },
});

process.stdout.write(
  `claude-pr-channel config editor\n` +
    `  editing  ${PATH_TO_CONFIG}\n` +
    `  open     http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${server.port}\n` +
    `  stop     ctrl-c\n`,
);
