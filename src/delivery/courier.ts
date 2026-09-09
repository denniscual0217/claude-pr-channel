import type { SessionQueue } from '../channel/queue.js';
import type { EventEnvelope } from '../types.js';
import { renderEventPrompt } from './prompt.js';

export interface DeliveryTarget {
  readonly sessionId: string;
  // A resumed session runs its tools where the process is spawned, so this must be the
  // worker's checkout or Claude acts on the wrong tree.
  readonly workerDir: string | null;
}

export type SendToSession = (
  target: DeliveryTarget,
  prompt: string,
  envelope: EventEnvelope,
) => Promise<void>;

export interface CourierResult {
  readonly delivered: string[];
  readonly stoppedAt: string | null;
}

// Pushes queued events into the worker's Claude Code session. An event is acked only
// once the session has taken it, so a failed send is retried when its lease expires
// rather than lost. Delivery stops at the first failure to keep PR events in order.
export class SessionCourier {
  readonly #queue: SessionQueue;
  readonly #send: SendToSession;
  readonly #target: DeliveryTarget;

  constructor(queue: SessionQueue, target: DeliveryTarget, send: SendToSession) {
    this.#queue = queue;
    this.#target = target;
    this.#send = send;
  }

  get sessionId(): string {
    return this.#queue.sessionId;
  }

  async deliverPending(limit = 10): Promise<CourierResult> {
    const { events } = this.#queue.poll({ limit });
    const delivered: string[] = [];

    for (const envelope of events) {
      try {
        await this.#send(this.#target, renderEventPrompt(envelope), envelope);
      } catch {
        return { delivered, stoppedAt: envelope.id };
      }
      this.#queue.ack([envelope.id]);
      delivered.push(envelope.id);
    }

    return { delivered, stoppedAt: null };
  }
}
