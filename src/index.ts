import { describeConfig, loadConfig, loadWebhookSecret } from './config.js';
import { claudeSessionSender } from './delivery/claude-session.js';
import { CourierService } from './delivery/service.js';
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
  // With a channel attached, the session's own channel process drains the queue. Running
  // the courier as well would race it and resume the session in a second process.
  const courier =
    config.delivery === 'courier'
      ? new CourierService({
          db,
          send: claudeSessionSender(),
          leaseMs: config.leaseTimeoutMs,
          logger: (entry) => log(JSON.stringify(entry)),
        })
      : null;

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${reason})`);
    courier?.stop();
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
    courier?.start();
    log(`listening on http://${address.host}:${address.port}/webhook`);
    log(
      courier === null
        ? 'delivery: channel — each session pulls its own events over its Claude Code channel'
        : 'delivery: courier — events are pushed with claude --resume',
    );
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
