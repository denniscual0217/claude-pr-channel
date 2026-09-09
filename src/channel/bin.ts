import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ChannelDb } from '../store/db.js';
import { channelProcessOptions, watchClientDisconnect } from './manager.js';
import { createChannelServer } from './mcp-server.js';

const DRAIN_CHECK_INTERVAL_MS = 1_000;

// stdout is the MCP transport; every diagnostic goes to stderr and carries ids and
// counts only, never event bodies.
function log(message: string): void {
  process.stderr.write(`[pr-channel] ${message}\n`);
}

async function main(): Promise<void> {
  const options = channelProcessOptions(process.argv.slice(2), process.env);
  const db = ChannelDb.open(options.dbPath);
  const channel = createChannelServer({ db, sessionId: options.sessionId, leaseMs: options.leaseMs });

  let exiting = false;
  const exit = async (reason: string, code: number): Promise<void> => {
    if (exiting) return;
    exiting = true;
    stopWatch();
    log(`exiting (${reason})`);
    try {
      await channel.server.close();
    } catch {
      // the transport may already be gone; nothing left to flush
    }
    db.close();
    process.exit(code);
  };

  const stopWatch = channel.manager.watchForDrain(options.sessionId, {
    intervalMs: DRAIN_CHECK_INTERVAL_MS,
    onDrained: () => void exit('route closed and queue drained', 0),
  });

  const transport = new StdioServerTransport();
  transport.onclose = () => void exit('client disconnected', 0);
  transport.onerror = (error) => log(`transport error: ${error.message}`);
  watchClientDisconnect(process.stdin, () => void exit('client disconnected', 0));
  process.once('SIGINT', () => void exit('SIGINT', 0));
  process.once('SIGTERM', () => void exit('SIGTERM', 0));

  await channel.server.connect(transport);
  const status = channel.manager.status(options.sessionId);
  log(`serving session ${options.sessionId} (state=${status.state}, unacked=${status.unacked})`);
}

main().catch((error: unknown) => {
  log(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
