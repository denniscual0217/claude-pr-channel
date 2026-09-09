import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ServiceConfig } from '../config.js';
import type { GithubEventName } from '../types.js';
import {
  allowedRepo,
  checkDeclaredLength,
  DeliveryRateLimiter,
  extractRepoFullName,
  isAllowedEventName,
  parseDeliveryId,
  readBodyWithLimit,
} from './limits.js';
import { SIGNATURE_HEADER, verifyWebhookSignature, type SignatureVerifier } from './signature.js';

export interface WebhookHeaders {
  readonly eventName: GithubEventName;
  readonly deliveryId: string;
  readonly repo: string;
}

export type WebhookHandler = (
  headers: WebhookHeaders,
  parsedPayload: Record<string, unknown>,
  rawDeliveryId: string,
) => Promise<void>;

export type WebhookOutcome =
  | 'accepted'
  | 'event_ignored'
  | 'payload_too_large'
  | 'client_aborted'
  | 'bad_signature'
  | 'rate_limited'
  | 'missing_delivery_id'
  | 'malformed_json'
  | 'repo_not_allowed'
  | 'handler_error';

// Every field here is either server-derived or already validated against an allowlist;
// raw header values and body text are never logged.
export interface WebhookLogEntry {
  readonly status: number | null;
  readonly outcome: WebhookOutcome;
  readonly detail: string | null;
  readonly deliveryId: string | null;
  readonly eventName: GithubEventName | null;
  readonly repo: string | null;
  readonly bytes: number;
  readonly durationMs: number;
}

export type WebhookLogger = (entry: WebhookLogEntry) => void;

export interface WebhookServerOptions {
  readonly config: Pick<ServiceConfig, 'host' | 'port' | 'maxPayloadBytes' | 'repoAllowlist' | 'rateLimit'>;
  readonly verifier: SignatureVerifier;
  readonly handler: WebhookHandler;
  readonly logger?: WebhookLogger;
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
}

export interface BoundAddress {
  readonly host: string;
  readonly port: number;
}

export interface WebhookServer {
  readonly httpServer: Server;
  listen(): Promise<BoundAddress>;
  close(): Promise<void>;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export function createWebhookServer(options: WebhookServerOptions): WebhookServer {
  const { config, verifier, handler } = options;
  const log = options.logger ?? defaultLogger;
  const now = options.now ?? Date.now;
  const limiter = new DeliveryRateLimiter(config.rateLimit);

  const httpServer = createServer({ requestTimeout: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS });
  httpServer.on('request', (req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) reply(req, res, 500, { error: 'internal_error' });
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return reply(req, res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
      return reply(req, res, 200, { status: 'ok' });
    }
    if (path === '/webhook') {
      if (req.method !== 'POST') return reply(req, res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
      return handleWebhook(req, res);
    }
    return reply(req, res, 404, { error: 'not_found' });
  }

  async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = now();
    const entry = {
      deliveryId: null as string | null,
      eventName: null as GithubEventName | null,
      repo: null as string | null,
      bytes: 0,
    };
    const finish = (status: number | null, outcome: WebhookOutcome, detail: string | null = null): void => {
      log({ status, outcome, detail, ...entry, durationMs: now() - started });
    };

    const declared = checkDeclaredLength(req.headers['content-length'], config.maxPayloadBytes);
    if (declared !== 'ok') {
      finish(413, 'payload_too_large', declared === 'invalid' ? 'invalid_content_length' : 'declared_length');
      return reply(req, res, 413, { error: 'payload_too_large' });
    }

    const read = await readBodyWithLimit(req, config.maxPayloadBytes);
    if (!read.ok) {
      entry.bytes = read.bytesRead;
      if (read.reason === 'aborted') {
        finish(null, 'client_aborted');
        if (!res.destroyed) res.destroy();
        return;
      }
      finish(413, 'payload_too_large', 'streamed_length');
      return reply(req, res, 413, { error: 'payload_too_large' });
    }
    entry.bytes = read.body.length;

    const signature = verifyWebhookSignature(read.body, req.headers[SIGNATURE_HEADER], verifier);
    if (!signature.ok) {
      finish(401, 'bad_signature', signature.reason);
      return reply(req, res, 401, { error: 'invalid_signature' });
    }

    // Counted after the signature check so only genuine deliveries spend the budget.
    const rate = limiter.tryAcquire(now());
    if (!rate.allowed) {
      finish(429, 'rate_limited');
      return reply(req, res, 429, { error: 'rate_limited' }, {
        'Retry-After': String(Math.ceil(rate.retryAfterMs / 1000)),
      });
    }

    const deliveryId = parseDeliveryId(req.headers['x-github-delivery']);
    if (deliveryId === null) {
      finish(400, 'missing_delivery_id');
      return reply(req, res, 400, { error: 'missing_delivery_id' });
    }
    entry.deliveryId = deliveryId;

    const payload = parseJsonObject(read.body);
    if (payload === null) {
      finish(400, 'malformed_json');
      return reply(req, res, 400, { error: 'malformed_json' });
    }

    const repo = allowedRepo(config.repoAllowlist, extractRepoFullName(payload));
    if (repo === null) {
      finish(403, 'repo_not_allowed');
      return reply(req, res, 403, { error: 'repository_not_allowed' });
    }
    entry.repo = repo;

    const eventHeader = req.headers['x-github-event'];
    if (!isAllowedEventName(eventHeader)) {
      finish(204, 'event_ignored');
      return reply(req, res, 204);
    }
    entry.eventName = eventHeader;

    try {
      await handler({ eventName: eventHeader, deliveryId, repo }, payload, deliveryId);
    } catch (error) {
      finish(500, 'handler_error', error instanceof Error ? error.name : 'unknown');
      return reply(req, res, 500, { error: 'internal_error' });
    }
    finish(202, 'accepted');
    return reply(req, res, 202, { status: 'accepted' });
  }

  return {
    httpServer,
    listen: () =>
      new Promise<BoundAddress>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(config.port, config.host, () => {
          httpServer.off('error', reject);
          const address = httpServer.address();
          if (address === null || typeof address === 'string') {
            reject(new Error('webhook server did not bind a TCP address'));
            return;
          }
          resolve({ host: address.address, port: address.port });
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.closeAllConnections();
        httpServer.close((error) => (error ? reject(error) : resolve()));
      }),
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

function reply(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body?: Record<string, string>,
  headers: Record<string, string> = {},
): void {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  res.writeHead(status, {
    ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) }),
    'Cache-Control': 'no-store',
    ...headers,
  });
  // If the request body was not fully read (oversized or unread), drop the socket after
  // the response is flushed so nothing further is read from it.
  res.end(payload, () => {
    if (!req.complete) req.socket.destroy();
  });
}

function defaultLogger(entry: WebhookLogEntry): void {
  process.stderr.write(`${JSON.stringify({ component: 'webhook', ...entry })}\n`);
}
