import { SessionQueue } from '../channel/queue.js';
import type { ChannelDb } from '../store/db.js';
import { SessionCourier, type SendToSession } from './courier.js';

export interface CourierServiceOptions {
  readonly db: ChannelDb;
  readonly send: SendToSession;
  readonly leaseMs: number;
  readonly intervalMs?: number;
  readonly batchLimit?: number;
  readonly logger?: (entry: Record<string, unknown>) => void;
}

export interface DrainSummary {
  readonly sessions: number;
  readonly delivered: number;
  readonly stalled: number;
}

// Drains every open route in turn. Routes are handled one at a time: a worker session
// runs real work per event, and overlapping sends into the same session would interleave
// two turns in one conversation.
export class CourierService {
  readonly #options: Required<Pick<CourierServiceOptions, 'intervalMs' | 'batchLimit'>> &
    CourierServiceOptions;
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(options: CourierServiceOptions) {
    this.#options = { intervalMs: 2_000, batchLimit: 10, ...options };
  }

  async drainOnce(): Promise<DrainSummary> {
    const { db, send, leaseMs, batchLimit, logger } = this.#options;
    let delivered = 0;
    let stalled = 0;
    const routes = db.listOpenRoutes();

    for (const route of routes) {
      const queue = new SessionQueue(db, route.sessionId, { leaseMs });
      const courier = new SessionCourier(
        queue,
        { sessionId: route.sessionId, workerDir: route.workerDir },
        send,
      );
      const result = await courier.deliverPending(batchLimit);
      delivered += result.delivered.length;
      if (result.stoppedAt !== null) stalled += 1;
      if (logger && (result.delivered.length > 0 || result.stoppedAt !== null)) {
        logger({
          component: 'courier',
          sessionId: route.sessionId,
          repo: route.prRef.repo,
          prNumber: route.prRef.prNumber,
          delivered: result.delivered.length,
          stalledOn: result.stoppedAt,
        });
      }
    }

    return { sessions: routes.length, delivered, stalled };
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      if (this.#running) return;
      this.#running = true;
      void this.drainOnce().finally(() => {
        this.#running = false;
      });
    }, this.#options.intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }
}
