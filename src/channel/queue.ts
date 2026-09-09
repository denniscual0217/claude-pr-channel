import type { ChannelDb, QueueStats } from '../store/db.js';
import type { EventEnvelope } from '../types.js';

export const DEFAULT_POLL_LIMIT = 50;
export const MAX_POLL_LIMIT = 100;

export interface SessionQueueOptions {
  readonly leaseMs: number;
  readonly now?: () => number;
}

export interface PollOptions {
  readonly limit?: number;
  readonly now?: number;
}

export interface PollResult {
  readonly events: EventEnvelope[];
  readonly leaseUntil: number;
}

export type AckResult =
  | { readonly status: 'ok'; readonly acked: string[]; readonly alreadyAcked: string[] }
  | { readonly status: 'rejected'; readonly rejected: string[] };

// One session's window onto the shared event table. The db scopes every lease by
// session_id; ack ownership is enforced here by only accepting ids this queue handed
// out, because db.ackEvent itself is not session-aware.
export class SessionQueue {
  readonly sessionId: string;
  readonly leaseMs: number;
  readonly #db: ChannelDb;
  readonly #now: () => number;
  readonly #delivered = new Set<string>();

  constructor(db: ChannelDb, sessionId: string, options: SessionQueueOptions) {
    if (sessionId.length === 0) throw new TypeError('sessionId must not be empty');
    if (!Number.isInteger(options.leaseMs) || options.leaseMs < 1) {
      throw new TypeError('leaseMs must be a positive integer');
    }
    this.#db = db;
    this.sessionId = sessionId;
    this.leaseMs = options.leaseMs;
    this.#now = options.now ?? Date.now;
  }

  poll(options: PollOptions = {}): PollResult {
    const now = options.now ?? this.#now();
    const limit = clampLimit(options.limit);
    const events = this.#db.leaseEvents(this.sessionId, { leaseMs: this.leaseMs, limit, now });
    for (const event of events) this.#delivered.add(event.id);
    return { events, leaseUntil: now + this.leaseMs };
  }

  owns(eventId: string): boolean {
    return this.#delivered.has(eventId);
  }

  ack(eventIds: readonly string[], now: number = this.#now()): AckResult {
    const unique = [...new Set(eventIds)];
    const rejected = unique.filter((id) => !this.owns(id));
    if (rejected.length > 0) return { status: 'rejected', rejected };

    return this.#db.transaction(() => {
      const acked: string[] = [];
      const alreadyAcked: string[] = [];
      for (const id of unique) {
        const outcome = this.#db.ackEvent(id, now);
        if (outcome === 'acked') acked.push(id);
        else if (outcome === 'already_acked') alreadyAcked.push(id);
        else throw new Error(`event ${id} was delivered to ${this.sessionId} but no longer exists`);
      }
      return { status: 'ok', acked, alreadyAcked };
    });
  }

  countUnacked(): number {
    return this.#db.countPending(this.sessionId);
  }

  stats(now: number = this.#now()): QueueStats {
    return this.#db.queueStats(this.sessionId, now);
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_POLL_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
  return Math.min(limit, MAX_POLL_LIMIT);
}
