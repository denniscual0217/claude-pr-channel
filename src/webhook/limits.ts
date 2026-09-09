import type { Readable } from 'node:stream';
import { normalizeRepo, type RateLimit } from '../config.js';
import { ALLOWED_GITHUB_EVENTS, type GithubEventName } from '../types.js';

export type BodyReadResult =
  | { readonly ok: true; readonly body: Buffer }
  | { readonly ok: false; readonly reason: 'too_large' | 'aborted'; readonly bytesRead: number };

// Resolves as soon as the cap is crossed, holding at most maxBytes in memory; the
// remainder of the stream is left unread for the caller to abort.
export function readBodyWithLimit(source: Readable, maxBytes: number): Promise<BodyReadResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (result: BodyReadResult): void => {
      if (settled) return;
      settled = true;
      source.off('data', onData);
      source.off('end', onEnd);
      source.off('error', onAbort);
      source.off('close', onAbort);
      resolve(result);
    };
    const onData = (chunk: Buffer | string): void => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      total += buf.length;
      if (total > maxBytes) {
        source.pause();
        finish({ ok: false, reason: 'too_large', bytesRead: total });
        return;
      }
      chunks.push(buf);
    };
    const onEnd = (): void => finish({ ok: true, body: Buffer.concat(chunks) });
    const onAbort = (): void => finish({ ok: false, reason: 'aborted', bytesRead: total });

    source.on('data', onData);
    source.on('end', onEnd);
    source.on('error', onAbort);
    source.on('close', onAbort);
  });
}

export type ContentLengthCheck = 'ok' | 'too_large' | 'invalid';

export function checkDeclaredLength(header: unknown, maxBytes: number): ContentLengthCheck {
  if (header === undefined) return 'ok';
  if (typeof header !== 'string' || !/^\d{1,18}$/.test(header)) return 'invalid';
  return Number(header) > maxBytes ? 'too_large' : 'ok';
}

const ALLOWED_EVENT_SET: ReadonlySet<string> = new Set(ALLOWED_GITHUB_EVENTS);

export function isAllowedEventName(name: unknown): name is GithubEventName {
  return typeof name === 'string' && ALLOWED_EVENT_SET.has(name);
}

export function extractRepoFullName(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const repository = (payload as { repository?: unknown }).repository;
  if (typeof repository !== 'object' || repository === null) return null;
  const fullName = (repository as { full_name?: unknown }).full_name;
  return typeof fullName === 'string' && fullName.length > 0 ? fullName : null;
}

export function allowedRepo(allowlist: ReadonlySet<string>, fullName: string | null): string | null {
  if (fullName === null) return null;
  const normalized = normalizeRepo(fullName);
  return allowlist.has(normalized) ? normalized : null;
}

const DELIVERY_ID = /^[A-Za-z0-9-]{1,64}$/;

export function parseDeliveryId(header: unknown): string | null {
  return typeof header === 'string' && DELIVERY_ID.test(header) ? header : null;
}

export type RateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterMs: number };

export class DeliveryRateLimiter {
  readonly #limit: RateLimit;
  #acceptedAt: number[] = [];

  constructor(limit: RateLimit) {
    this.#limit = limit;
  }

  tryAcquire(now: number = Date.now()): RateLimitDecision {
    const windowStart = now - this.#limit.windowMs;
    const firstLive = this.#acceptedAt.findIndex((t) => t > windowStart);
    this.#acceptedAt = firstLive === -1 ? [] : this.#acceptedAt.slice(firstLive);

    if (this.#acceptedAt.length >= this.#limit.maxDeliveries) {
      const oldest = this.#acceptedAt[0] ?? now;
      return { allowed: false, retryAfterMs: Math.max(1, oldest + this.#limit.windowMs - now) };
    }
    this.#acceptedAt.push(now);
    return { allowed: true };
  }
}
