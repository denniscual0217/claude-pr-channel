import type { RateLimit } from '../config.js';
import { normalizeRepo } from '../events/repo.js';
import type { GithubEventName } from '../types.js';
import {
  checkDeclaredLength,
  DeliveryRateLimiter,
  extractRepoFullName,
  isAllowedEventName,
  parseDeliveryId,
} from './limits.js';
import { SIGNATURE_HEADER, verifyWebhookSignature, type SignatureVerifier } from './signature.js';

export interface DeliveryHeaders {
  readonly eventName: GithubEventName;
  readonly deliveryId: string;
  readonly repo: string;
}

export type DeliveryHandler = (
  headers: DeliveryHeaders,
  parsedPayload: Record<string, unknown>,
  rawBody: Buffer,
) => Promise<void> | void;

export type PingHandler = (payload: Record<string, unknown>, rawBody: Buffer) => void;

export type ListenerOutcome =
  | 'accepted'
  | 'ping'
  | 'event_ignored'
  | 'payload_too_large'
  | 'bad_signature'
  | 'rate_limited'
  | 'missing_delivery_id'
  | 'malformed_json'
  | 'repo_not_allowed'
  | 'handler_error'
  | 'not_found'
  | 'method_not_allowed';

// Every field is server-derived or validated against an allowlist; raw header values and
// body text are never logged.
export interface ListenerLogEntry {
  readonly status: number;
  readonly outcome: ListenerOutcome;
  readonly detail: string | null;
  readonly deliveryId: string | null;
  readonly eventName: GithubEventName | null;
  readonly repo: string | null;
  readonly bytes: number;
}

export interface ListenerOptions {
  readonly verifier: SignatureVerifier;
  readonly expectedRepo: string;
  readonly maxPayloadBytes: number;
  readonly rateLimit: RateLimit;
  readonly onDelivery: DeliveryHandler;
  readonly onPing?: PingHandler;
  readonly logger?: (entry: ListenerLogEntry) => void;
  readonly now?: () => number;
}

export interface Listener {
  readonly port: number;
  readonly url: string;
  stop(): Promise<void>;
}

export const WEBHOOK_PATH = '/webhook';

export function createListener(options: ListenerOptions): Listener {
  const log = options.logger ?? (() => {});
  const now = options.now ?? Date.now;
  const limiter = new DeliveryRateLimiter(options.rateLimit);
  const expectedRepo = normalizeRepo(options.expectedRepo);

  const server = Bun.serve({
    // Loopback only: nothing outside this machine can reach the listener, which is what
    // makes an ephemeral port and a per-session secret enough.
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: options.maxPayloadBytes,
    fetch: (request) => handle(request),
  });

  async function handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== WEBHOOK_PATH) return done(404, 'not_found', null, { bytes: 0 });
    if (request.method !== 'POST') {
      return done(405, 'method_not_allowed', null, { bytes: 0 }, { Allow: 'POST' });
    }

    const declared = checkDeclaredLength(request.headers.get('content-length') ?? undefined, options.maxPayloadBytes);
    if (declared !== 'ok') {
      return done(413, 'payload_too_large', declared === 'invalid' ? 'invalid_content_length' : 'declared_length', {
        bytes: 0,
      });
    }

    let raw: Buffer;
    try {
      raw = Buffer.from(await request.arrayBuffer());
    } catch {
      return done(413, 'payload_too_large', 'body_read', { bytes: 0 });
    }
    const bytes = raw.length;
    if (bytes > options.maxPayloadBytes) return done(413, 'payload_too_large', 'read_length', { bytes });

    // Signature first, over the RAW bytes: nothing after this point looks at a body that
    // did not come from GitHub through our own forwarder.
    const signature = verifyWebhookSignature(raw, request.headers.get(SIGNATURE_HEADER) ?? undefined, options.verifier);
    if (!signature.ok) return done(401, 'bad_signature', signature.reason, { bytes });

    // Counted after the signature check so only genuine deliveries spend the budget.
    const rate = limiter.tryAcquire(now());
    if (!rate.allowed) {
      return done(429, 'rate_limited', null, { bytes }, { 'Retry-After': String(Math.ceil(rate.retryAfterMs / 1000)) });
    }

    const deliveryId = parseDeliveryId(request.headers.get('x-github-delivery') ?? undefined);
    if (deliveryId === null) return done(400, 'missing_delivery_id', null, { bytes });

    const payload = parseJsonObject(raw);
    if (payload === null) return done(400, 'malformed_json', null, { bytes, deliveryId });

    const fullName = extractRepoFullName(payload);
    const repo = fullName === null ? null : normalizeRepo(fullName);
    if (repo === null || repo !== expectedRepo) return done(403, 'repo_not_allowed', null, { bytes, deliveryId });

    const eventHeader = request.headers.get('x-github-event');
    if (eventHeader === 'ping') {
      options.onPing?.(payload, raw);
      return done(204, 'ping', null, { bytes, deliveryId, repo });
    }
    if (!isAllowedEventName(eventHeader)) return done(204, 'event_ignored', null, { bytes, deliveryId, repo });

    try {
      await options.onDelivery({ eventName: eventHeader, deliveryId, repo }, payload, raw);
    } catch (error) {
      return done(500, 'handler_error', error instanceof Error ? error.name : 'unknown', {
        bytes,
        deliveryId,
        repo,
        eventName: eventHeader,
      });
    }
    return done(202, 'accepted', null, { bytes, deliveryId, repo, eventName: eventHeader });
  }

  function done(
    status: number,
    outcome: ListenerOutcome,
    detail: string | null,
    fields: { bytes: number; deliveryId?: string; repo?: string; eventName?: GithubEventName },
    headers: Record<string, string> = {},
  ): Response {
    log({
      status,
      outcome,
      detail,
      deliveryId: fields.deliveryId ?? null,
      eventName: fields.eventName ?? null,
      repo: fields.repo ?? null,
      bytes: fields.bytes,
    });
    const body = status === 204 ? null : JSON.stringify({ outcome });
    return new Response(body, {
      status,
      headers: {
        'Cache-Control': 'no-store',
        ...(body === null ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
    });
  }

  return {
    port: server.port ?? 0,
    url: `http://127.0.0.1:${server.port ?? 0}${WEBHOOK_PATH}`,
    stop: async () => {
      await server.stop(true);
    },
  };
}

function parseJsonObject(body: Buffer): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}
