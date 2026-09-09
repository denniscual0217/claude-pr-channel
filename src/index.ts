import { describeConfig, loadConfig, loadWebhookSecret } from './config.js';
import { createDispatcher } from './dispatcher.js';
import { ChannelDb } from './store/db.js';

function log(message: string): void {
  process.stderr.write(`[pr-dispatcher] ${message}\n`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const verifier = loadWebhookSecret();
  const db = ChannelDb.open(config.dbPath);
  const dispatcher = createDispatcher({ db, config, verifier });

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${reason})`);
    try {
      await dispatcher.close();
    } catch (error) {
      log(`http close failed: ${error instanceof Error ? error.name : 'unknown'}`);
    }
    db.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    const address = await dispatcher.listen();
    log(`listening on http://${address.host}:${address.port}/webhook`);
    log('each registered session receives its events over its Claude Code channel');
    log(JSON.stringify({ config: describeConfig(config) }));
  } catch (error) {
    db.close();
    throw error;
  }
}

main().catch((error: unknown) => {
  log(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
