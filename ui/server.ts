// A local editor for the configuration file. The address decides who can reach it; the
// token in the printed link decides who may edit. A login would be the wrong shape — this
// serves one person, and the token lives beside the file it protects, at the same mode.
// It binds loopback unless told otherwise, and this file decides who may drive an agent
// that pushes code, so widen the bind only to an address that is already access-
// controlled, such as a VPN interface. PR_CHANNEL_UI_HOST refuses the wildcard addresses
// for that reason: on a box with a public interface they would put this editor on the
// internet.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// Persisted so a restart does not invalidate the link on someone's phone.
export function loadOrCreateToken(pathToConfig: string): string {
  const file = join(dirname(pathToConfig), 'ui-token');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length > 0) {
      chmodSync(file, 0o600);
      return existing;
    }
  } catch {
    // No token yet.
  }
  mkdirSync(dirname(file), { recursive: true });
  const token = randomBytes(32).toString('hex');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

function bearerMatches(header: string | null, token: string): boolean {
  const offered = Buffer.from((header ?? '').replace(/^Bearer /i, ''), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return offered.length === expected.length && timingSafeEqual(offered, expected);
}

export interface EditorOptions {
  readonly configPath: string;
  readonly token: string;
  readonly page: string;
  readonly schema: () => Record<string, unknown>;
  readonly validate: (text: string) => { ok: true } | { ok: false; message: string };
}

export function createEditor(options: EditorOptions): (request: Request) => Promise<Response> {
  const pathToConfig = options.configPath;

  async function readCurrent(): Promise<{ text: string; exists: boolean }> {
    try {
      return { text: await readFile(pathToConfig, 'utf8'), exists: true };
    } catch {
      return { text: '{}\n', exists: false };
    }
  }

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      // The form is generated from the schema, so a cached page outlives the schema it was
      // built for: it keeps rendering fields that no longer exist and saves keys the
      // validator now refuses, which reads as a bad config rather than a stale tab.
      return new Response(Bun.file(options.page), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    if (url.pathname.startsWith('/api/') && !bearerMatches(request.headers.get('authorization'), options.token)) {
      return json({ error: 'open the link printed by bun run config; it carries the token' }, 401);
    }

    if (request.method === 'GET' && url.pathname === '/api/schema') {
      return json(options.schema());
    }
    if (request.method === 'GET' && url.pathname === '/api/config') {
      const { text, exists } = await readCurrent();
      return json({ path: pathToConfig, exists, text });
    }
    if (request.method === 'PUT' && url.pathname === '/api/config') {
      const body = (await request.json().catch(() => null)) as { text?: string } | null;
      const text = typeof body?.text === 'string' ? body.text : null;
      if (text === null) return json({ error: 'expected { "text": "<file contents>" }' }, 400);

      const checked = options.validate(text);
      if (!checked.ok) return json({ error: checked.message }, 422);

      // Written through a temporary file: a crash mid-write leaves the old config intact
      // rather than a truncated one the plugin would refuse at next launch.
      await mkdir(dirname(pathToConfig), { recursive: true });
      const temporary = `${pathToConfig}.tmp-${process.pid}`;
      await writeFile(temporary, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 });
      await rename(temporary, pathToConfig);
      return json({ path: pathToConfig, saved: true });
    }
    return new Response('not found', { status: 404 });
  };
}

// Validated by the same loader the plugin uses, against the text about to be written —
// a second implementation here could accept what the plugin then refuses at startup.
function validateWith(pathToConfig: string) {
  return (text: string): { ok: true } | { ok: false; message: string } => {
    const probe = `${pathToConfig}.ui-check`;
    const result = loadConfig({
      env: { ...process.env, [CONFIG_PATH_ENV]: probe },
      readFile: (path: string) => (path === probe ? text : (() => { throw new Error('ENOENT'); })()),
    });
    return result.ok ? { ok: true } : { ok: false, message: result.error.message };
  };
}

if (import.meta.main) {
  const HOST = host(process.env);
  const PORT = Number(process.env['PR_CHANNEL_UI_PORT'] ?? 4319);
  const PATH_TO_CONFIG = configPath(process.env);
  const TOKEN = loadOrCreateToken(PATH_TO_CONFIG);

  const server = Bun.serve({
    hostname: HOST,
    port: PORT,
    fetch: createEditor({
      configPath: PATH_TO_CONFIG,
      token: TOKEN,
      page: join(import.meta.dir, 'index.html'),
      schema: configJsonSchema,
      validate: validateWith(PATH_TO_CONFIG),
    }),
  });

  process.stdout.write(
    `claude-pr-channel config editor\n` +
      `  editing  ${PATH_TO_CONFIG}\n` +
      `  open     http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${server.port}/#${TOKEN}\n` +
      `  stop     ctrl-c\n`,
  );
}
