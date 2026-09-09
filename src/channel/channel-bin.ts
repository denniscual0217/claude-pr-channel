import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULTS, ENV } from '../config.js';
import { PrRegistry } from '../registry/registry.js';
import { ChannelDb } from '../store/db.js';
import { SessionQueue } from './queue.js';
import { createPrChannelServer, pumpOnce } from './channel-server.js';

const POLL_MS = 1_000;

// stdout is the MCP transport; diagnostics carry ids and counts only, never event bodies.
function log(message: string): void {
  process.stderr.write(`[pr-channel] ${message}\n`);
}

// Claude Code spawns this as a subprocess and passes the session it belongs to, so the
// channel identifies itself instead of being told.
function sessionId(): string {
  const id = process.env['CLAUDE_CODE_SESSION_ID']?.trim();
  if (!id) throw new Error('CLAUDE_CODE_SESSION_ID is not set; run this as a Claude Code channel');
  return id;
}

function workerDir(): string {
  return process.env['CLAUDE_PROJECT_DIR']?.trim() || process.cwd();
}

async function main(): Promise<void> {
  const session = sessionId();
  const dir = workerDir();
  const db = ChannelDb.open(process.env[ENV.dbPath]?.trim() || DEFAULTS.dbPath);
  const leaseMs = Number(process.env[ENV.leaseTimeoutMs] ?? DEFAULTS.leaseTimeoutMs) || DEFAULTS.leaseTimeoutMs;

  // If this session already holds a route, keep its worker directory pointed here: the
  // channel runs in the checkout Claude Code is actually working in.
  const route = db.getRouteBySession(session);
  if (route && route.workerDir !== dir) {
    new PrRegistry(db).register({
      prRef: route.prRef,
      sessionId: session,
      workerDir: dir,
      replace: true,
    });
  }

  const server = createPrChannelServer();
  const queue = new SessionQueue(db, session, { leaseMs });
  await server.connect(new StdioServerTransport());
  log(`channel open for session ${session.slice(0, 8)} in ${dir}${route ? ` (${route.prRef.repo}#${route.prRef.prNumber})` : ' (no route yet)'}`);

  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    stopped = true;
    void pumpOnce(queue, server, { onError: (error) => log(`push failed: ${error instanceof Error ? error.name : 'unknown'}`) })
      .then((pushed) => {
        if (pushed > 0) log(`pushed ${pushed} event(s)`);
      })
      .finally(() => {
        stopped = false;
      });
  }, POLL_MS);
  timer.unref();

  const shutdown = (reason: string): void => {
    clearInterval(timer);
    log(`closing (${reason})`);
    db.close();
    process.exit(0);
  };
  process.stdin.on('end', () => shutdown('client disconnected'));
  process.stdin.on('close', () => shutdown('client disconnected'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  log(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
