import { createHmac } from 'node:crypto';
import { request, type IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebhookSecret } from '../config.js';
import { createWebhookServer, type WebhookHeaders, type WebhookLogEntry, type WebhookServer } from './server.js';

const FAKE_SECRET = 'test-only-fake-secret';
const REPO = 'toptal/some-repo';
const DELIVERY = '72d3162e-cc78-11e3-81ab-4c9367dc0958';
const SENTINEL = 'zz-untrusted-comment-body-marker-zz';

const sign = (raw: Buffer | string): string =>
  `sha256=${createHmac('sha256', FAKE_SECRET).update(raw).digest('hex')}`;

const payloadJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    action: 'created',
    repository: { full_name: 'Toptal/Some-Repo' },
    issue: { number: 7, pull_request: {} },
    comment: { id: 1, body: SENTINEL },
    ...overrides,
  });

interface Reply {
  readonly status: number;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

interface Calls {
  readonly handler: Array<{ headers: WebhookHeaders; payload: Record<string, unknown>; raw: string }>;
  readonly log: WebhookLogEntry[];
}

interface Harness extends Calls {
  readonly server: WebhookServer;
  readonly port: number;
  post(body: string | Buffer, headers?: Record<string, string>): Promise<Reply>;
  get(path: string): Promise<Reply>;
}

const harnesses: WebhookServer[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((s) => s.close()));
});

async function start(options: { maxPayloadBytes?: number; rateMax?: number; fail?: Error } = {}): Promise<Harness> {
  const calls: Calls = { handler: [], log: [] };
  const server = createWebhookServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      maxPayloadBytes: options.maxPayloadBytes ?? 65_536,
      repoAllowlist: new Set([REPO]),
      rateLimit: { maxDeliveries: options.rateMax ?? 1000, windowMs: 60_000 },
    },
    verifier: new WebhookSecret(FAKE_SECRET),
    handler: async (headers, payload, raw) => {
      if (options.fail) throw options.fail;
      calls.handler.push({ headers, payload, raw });
    },
    logger: (entry) => calls.log.push(entry),
  });
  harnesses.push(server);
  const { host, port } = await server.listen();
  expect(host).toBe('127.0.0.1');

  const send = (method: string, path: string, body: Buffer | undefined, headers: Record<string, string>): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      });
      req.on('error', reject);
      req.end(body);
    });

  return {
    ...calls,
    server,
    port,
    post: (body, headers = {}) => {
      const raw = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
      return send('POST', '/webhook', raw, {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': DELIVERY,
        'x-hub-signature-256': sign(raw),
        ...headers,
      });
    },
    get: (path) => send('GET', path, undefined, {}),
  };
}

describe('webhook server', () => {
  it('binds to loopback only', async () => {
    const h = await start();
    const address = h.server.httpServer.address();
    expect(address).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
  });

  it('serves /healthz without revealing anything', async () => {
    const h = await start();
    const reply = await h.get('/healthz');
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ status: 'ok' });
    expect(reply.body).not.toMatch(/repo|secret|allow|port|sha256/i);
  });

  it('accepts a genuinely signed delivery and hands off the parsed payload', async () => {
    const h = await start();
    const reply = await h.post(payloadJson());
    expect(reply.status).toBe(202);
    expect(JSON.parse(reply.body)).toEqual({ status: 'accepted' });
    expect(h.handler).toHaveLength(1);
    const call = h.handler[0]!;
    expect(call.headers).toEqual({ eventName: 'issue_comment', deliveryId: DELIVERY, repo: REPO });
    expect(call.raw).toBe(DELIVERY);
    expect(call.payload).toMatchObject({ action: 'created', comment: { body: SENTINEL } });
    expect(h.log).toHaveLength(1);
    expect(h.log[0]).toMatchObject({ status: 202, outcome: 'accepted', deliveryId: DELIVERY, eventName: 'issue_comment', repo: REPO });
  });

  it('rejects a tampered body with 401 and never parses or echoes it', async () => {
    const h = await start();
    const original = payloadJson();
    const tampered = original.replace('"created"', '"deleted"');
    const reply = await h.post(tampered, { 'x-hub-signature-256': sign(original) });
    expect(reply.status).toBe(401);
    expect(h.handler).toHaveLength(0);
    expect(reply.body).not.toContain(SENTINEL);
    expect(JSON.stringify(h.log)).not.toContain(SENTINEL);
    expect(h.log[0]).toMatchObject({ status: 401, outcome: 'bad_signature', detail: 'mismatch', deliveryId: null });
  });

  it('returns 401 for missing, wrong-prefix, and wrong-length signatures without crashing', async () => {
    const h = await start();
    const body = payloadJson();
    expect((await h.post(body, { 'x-hub-signature-256': '' })).status).toBe(401);
    expect((await h.post(body, { 'x-hub-signature-256': `sha1=${sign(body).slice(7)}` })).status).toBe(401);
    expect((await h.post(body, { 'x-hub-signature-256': 'sha256=deadbeef' })).status).toBe(401);
    expect(h.handler).toHaveLength(0);
    expect(h.log.map((e) => e.detail)).toEqual(['missing_header', 'wrong_prefix', 'wrong_length']);
  });

  it('checks the signature before it looks at the delivery id or JSON', async () => {
    const h = await start();
    const reply = await h.post('{not json', { 'x-hub-signature-256': 'sha256=deadbeef', 'x-github-delivery': '' });
    expect(reply.status).toBe(401);
  });

  it('rejects a declared oversized body with 413 without reading it', async () => {
    const h = await start({ maxPayloadBytes: 1024 });
    const big = Buffer.alloc(4096, 0x20);
    const reply = await h.post(big, { 'content-length': String(big.length) }).catch((error: NodeJS.ErrnoException) => error);
    // The socket is dropped after the reply is flushed; either the reply or a reset is acceptable.
    if (reply instanceof Error) expect(['ECONNRESET', 'EPIPE']).toContain(reply.code);
    else expect(reply.status).toBe(413);
    expect(h.handler).toHaveLength(0);
    expect(h.log[0]).toMatchObject({ status: 413, outcome: 'payload_too_large', detail: 'declared_length', bytes: 0 });
  });

  it('aborts a streamed oversized body with 413 before the client finishes sending', async () => {
    const h = await start({ maxPayloadBytes: 1024 });
    const chunk = Buffer.alloc(512, 0x7b);

    const outcome = await new Promise<{ status: number | null; clientFinished: boolean; error: string | null }>((resolve) => {
      let clientFinished = false;
      let done = false;
      const settle = (status: number | null, error: string | null): void => {
        if (done) return;
        done = true;
        resolve({ status, clientFinished, error });
      };
      const req = request(
        {
          host: '127.0.0.1',
          port: h.port,
          method: 'POST',
          path: '/webhook',
          headers: {
            'content-type': 'application/json',
            'transfer-encoding': 'chunked',
            'x-github-event': 'issue_comment',
            'x-github-delivery': DELIVERY,
            'x-hub-signature-256': sign('irrelevant'),
          },
        },
        (res) => {
          res.resume();
          settle(res.statusCode ?? null, null);
          req.destroy();
        },
      );
      req.on('error', (error: NodeJS.ErrnoException) => settle(null, error.code ?? error.message));

      let sent = 0;
      const pump = (): void => {
        if (done) return;
        if (sent >= 64) {
          clientFinished = true;
          req.end();
          return;
        }
        sent += 1;
        req.write(chunk, () => setTimeout(pump, 5));
      };
      pump();
    });

    expect(outcome.status).toBe(413);
    expect(outcome.clientFinished).toBe(false);
    expect(h.handler).toHaveLength(0);
    const entry = h.log[0]!;
    expect(entry).toMatchObject({ status: 413, outcome: 'payload_too_large', detail: 'streamed_length' });
    expect(entry.bytes).toBeGreaterThan(1024);
    expect(entry.bytes).toBeLessThanOrEqual(1024 + chunk.length);
  });

  it('rejects a signed delivery for a repository outside the allowlist', async () => {
    const h = await start();
    const reply = await h.post(payloadJson({ repository: { full_name: 'someone-else/some-repo' } }));
    expect(reply.status).toBe(403);
    expect(reply.body).not.toContain('someone-else');
    expect(h.handler).toHaveLength(0);
    expect(h.log[0]).toMatchObject({ status: 403, outcome: 'repo_not_allowed', repo: null, deliveryId: DELIVERY });
    expect(JSON.stringify(h.log)).not.toContain('someone-else');
  });

  it('rejects a payload with no repository', async () => {
    const h = await start();
    expect((await h.post(payloadJson({ repository: undefined }))).status).toBe(403);
    expect(h.handler).toHaveLength(0);
  });

  it('ignores signed events outside the event allowlist without handing them off', async () => {
    const h = await start();
    for (const event of ['ping', 'push', 'PULL_REQUEST']) {
      const reply = await h.post(payloadJson(), { 'x-github-event': event });
      expect(reply.status).toBe(204);
      expect(reply.body).toBe('');
    }
    expect(h.handler).toHaveLength(0);
    expect(h.log.every((e) => e.outcome === 'event_ignored' && e.eventName === null)).toBe(true);
    expect(JSON.stringify(h.log)).not.toContain('PULL_REQUEST');
  });

  it('returns 400 for a signed body that is not a JSON object', async () => {
    const h = await start();
    for (const body of ['{not json', '[]', '"string"', 'null', '']) {
      const reply = await h.post(body);
      expect(reply.status).toBe(400);
      expect(JSON.parse(reply.body)).toEqual({ error: 'malformed_json' });
    }
    expect(h.handler).toHaveLength(0);
    expect(h.log.every((e) => e.outcome === 'malformed_json')).toBe(true);
    expect(JSON.stringify(h.log)).not.toContain('not json');
  });

  it('returns 400 when the delivery id is missing or malformed', async () => {
    const h = await start();
    expect((await h.post(payloadJson(), { 'x-github-delivery': '' })).status).toBe(400);
    expect((await h.post(payloadJson(), { 'x-github-delivery': 'not a valid id' })).status).toBe(400);
    expect(h.handler).toHaveLength(0);
    expect(JSON.stringify(h.log)).not.toContain('not a valid id');
  });

  it('trips the rate limiter after the configured number of signed deliveries', async () => {
    const h = await start({ rateMax: 2 });
    expect((await h.post(payloadJson())).status).toBe(202);
    expect((await h.post(payloadJson())).status).toBe(202);
    const limited = await h.post(payloadJson());
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(h.handler).toHaveLength(2);
    expect(h.log[2]).toMatchObject({ status: 429, outcome: 'rate_limited' });
  });

  it('does not let unsigned traffic consume the delivery budget', async () => {
    const h = await start({ rateMax: 1 });
    for (let i = 0; i < 5; i += 1) {
      expect((await h.post(payloadJson(), { 'x-hub-signature-256': 'sha256=deadbeef' })).status).toBe(401);
    }
    expect((await h.post(payloadJson())).status).toBe(202);
  });

  it('returns a generic 500 when the handler throws, without the error text', async () => {
    const h = await start({ fail: new Error(`handler exploded on ${SENTINEL}`) });
    const reply = await h.post(payloadJson());
    expect(reply.status).toBe(500);
    expect(reply.body).not.toContain(SENTINEL);
    expect(JSON.stringify(h.log)).not.toContain(SENTINEL);
    expect(h.log[0]).toMatchObject({ status: 500, outcome: 'handler_error', detail: 'Error' });
  });

  it('answers unknown paths and methods without touching the handler', async () => {
    const h = await start();
    expect((await h.get('/webhook')).status).toBe(405);
    expect((await h.get('/')).status).toBe(404);
    expect((await h.get('/admin')).status).toBe(404);
    expect(h.handler).toHaveLength(0);
    expect(h.log).toHaveLength(0);
  });
});
