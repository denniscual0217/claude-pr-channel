import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'bun:test';
import { WebhookSecret } from './secret.js';
import { createListener, type DeliveryHeaders, type Listener, type ListenerLogEntry } from './listener.js';

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

interface Harness {
  readonly listener: Listener;
  readonly handler: { headers: DeliveryHeaders; payload: Record<string, unknown>; raw: Buffer }[];
  readonly pings: Record<string, unknown>[];
  readonly log: ListenerLogEntry[];
  post(body: string | Buffer, headers?: Record<string, string>): Promise<Response>;
  send(method: string, path: string): Promise<Response>;
}

const open: Listener[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((listener) => listener.stop()));
});

function start(options: { maxPayloadBytes?: number; rateMax?: number; fail?: Error } = {}): Harness {
  const handler: Harness['handler'] = [];
  const pings: Record<string, unknown>[] = [];
  const log: ListenerLogEntry[] = [];
  const listener = createListener({
    verifier: new WebhookSecret(FAKE_SECRET),
    expectedRepo: REPO,
    maxPayloadBytes: options.maxPayloadBytes ?? 65_536,
    rateLimit: { maxDeliveries: options.rateMax ?? 1000, windowMs: 60_000 },
    onDelivery: (headers, payload, raw) => {
      if (options.fail) throw options.fail;
      handler.push({ headers, payload, raw });
    },
    onPing: (payload) => pings.push(payload),
    logger: (entry) => log.push(entry),
  });
  open.push(listener);

  return {
    listener,
    handler,
    pings,
    log,
    post: (body, headers = {}) => {
      const raw = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
      return fetch(listener.url, {
        method: 'POST',
        body: new Uint8Array(raw),
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issue_comment',
          'x-github-delivery': DELIVERY,
          'x-hub-signature-256': sign(raw),
          ...headers,
        },
      });
    },
    send: (method, path) => fetch(`http://127.0.0.1:${listener.port}${path}`, { method }),
  };
}

describe('listener', () => {
  it('binds an ephemeral loopback port so two sessions cannot collide', () => {
    const a = start();
    const b = start();
    expect(a.listener.port).toBeGreaterThan(0);
    expect(a.listener.url.startsWith('http://127.0.0.1:')).toBe(true);
    expect(a.listener.port).not.toBe(b.listener.port);
  });

  it('accepts a genuinely signed delivery and hands off the parsed payload', async () => {
    const h = start();
    const reply = await h.post(payloadJson());
    expect(reply.status).toBe(202);
    expect(h.handler).toHaveLength(1);
    const call = h.handler[0]!;
    expect(call.headers).toEqual({ eventName: 'issue_comment', deliveryId: DELIVERY, repo: REPO });
    expect(call.payload).toMatchObject({ action: 'created', comment: { body: SENTINEL } });
    expect(h.log[0]).toMatchObject({ status: 202, outcome: 'accepted', deliveryId: DELIVERY, eventName: 'issue_comment', repo: REPO });
  });

  it('rejects a tampered body with 401 and never parses or echoes it', async () => {
    const h = start();
    const original = payloadJson();
    const tampered = original.replace('"created"', '"deleted"');
    const reply = await h.post(tampered, { 'x-hub-signature-256': sign(original) });
    expect(reply.status).toBe(401);
    expect(h.handler).toHaveLength(0);
    expect(await reply.text()).not.toContain(SENTINEL);
    expect(JSON.stringify(h.log)).not.toContain(SENTINEL);
    expect(h.log[0]).toMatchObject({ status: 401, outcome: 'bad_signature', detail: 'mismatch', deliveryId: null });
  });

  it('returns 401 for missing, wrong-prefix, and wrong-length signatures without crashing', async () => {
    const h = start();
    const body = payloadJson();
    expect((await h.post(body, { 'x-hub-signature-256': '' })).status).toBe(401);
    expect((await h.post(body, { 'x-hub-signature-256': `sha1=${sign(body).slice(7)}` })).status).toBe(401);
    expect((await h.post(body, { 'x-hub-signature-256': 'sha256=deadbeef' })).status).toBe(401);
    expect(h.handler).toHaveLength(0);
    expect(h.log.map((entry) => entry.detail)).toEqual(['missing_header', 'wrong_prefix', 'wrong_length']);
  });

  it('checks the signature before it looks at the delivery id or JSON', async () => {
    const h = start();
    const reply = await h.post('{not json', { 'x-hub-signature-256': 'sha256=deadbeef', 'x-github-delivery': '' });
    expect(reply.status).toBe(401);
  });

  // Bun's own maxRequestBodySize answers 413 before the handler is entered, so an
  // oversized body is never read into this process at all and never reaches the log.
  it('rejects an oversized body with 413 without reading it', async () => {
    const h = start({ maxPayloadBytes: 1024 });
    const reply = await h.post(Buffer.alloc(4096, 0x20));
    expect(reply.status).toBe(413);
    expect(h.handler).toHaveLength(0);
    expect(h.log).toHaveLength(0);
  });

  it('rejects a signed delivery for any repository but the tracked one', async () => {
    const h = start();
    const reply = await h.post(payloadJson({ repository: { full_name: 'someone-else/some-repo' } }));
    expect(reply.status).toBe(403);
    expect(await reply.text()).not.toContain('someone-else');
    expect(h.handler).toHaveLength(0);
    expect(h.log[0]).toMatchObject({ status: 403, outcome: 'repo_not_allowed', repo: null, deliveryId: DELIVERY });
    expect(JSON.stringify(h.log)).not.toContain('someone-else');
  });

  it('rejects a payload with no repository', async () => {
    const h = start();
    expect((await h.post(payloadJson({ repository: undefined }))).status).toBe(403);
    expect(h.handler).toHaveLength(0);
  });

  // The ping GitHub sends when gh creates the hook is how the hook's own id is confirmed,
  // so it goes to onPing rather than into the event pipeline.
  it('routes a signed ping to onPing and never to the delivery handler', async () => {
    const h = start();
    const body = payloadJson({ hook_id: 55, zen: 'Design for failure.' });
    const reply = await h.post(body, { 'x-github-event': 'ping' });
    expect(reply.status).toBe(204);
    expect(h.handler).toHaveLength(0);
    expect(h.pings).toHaveLength(1);
    expect(h.pings[0]).toMatchObject({ hook_id: 55 });
    expect(h.log[0]).toMatchObject({ outcome: 'ping' });
  });

  it('ignores signed events outside the event allowlist without handing them off', async () => {
    const h = start();
    for (const event of ['push', 'PULL_REQUEST']) {
      const reply = await h.post(payloadJson(), { 'x-github-event': event });
      expect(reply.status).toBe(204);
      expect(await reply.text()).toBe('');
    }
    expect(h.handler).toHaveLength(0);
    expect(h.log.every((entry) => entry.outcome === 'event_ignored' && entry.eventName === null)).toBe(true);
    expect(JSON.stringify(h.log)).not.toContain('PULL_REQUEST');
  });

  it('returns 400 for a signed body that is not a JSON object', async () => {
    const h = start();
    for (const body of ['{not json', '[]', '"string"', 'null', '']) {
      expect((await h.post(body)).status).toBe(400);
    }
    expect(h.handler).toHaveLength(0);
    expect(h.log.every((entry) => entry.outcome === 'malformed_json')).toBe(true);
    expect(JSON.stringify(h.log)).not.toContain('not json');
  });

  it('returns 400 when the delivery id is missing or malformed', async () => {
    const h = start();
    expect((await h.post(payloadJson(), { 'x-github-delivery': '' })).status).toBe(400);
    expect((await h.post(payloadJson(), { 'x-github-delivery': 'not a valid id' })).status).toBe(400);
    expect(h.handler).toHaveLength(0);
    expect(JSON.stringify(h.log)).not.toContain('not a valid id');
  });

  it('trips the rate limiter after the configured number of signed deliveries', async () => {
    const h = start({ rateMax: 2 });
    expect((await h.post(payloadJson())).status).toBe(202);
    expect((await h.post(payloadJson())).status).toBe(202);
    const limited = await h.post(payloadJson());
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(h.handler).toHaveLength(2);
    expect(h.log[2]).toMatchObject({ status: 429, outcome: 'rate_limited' });
  });

  it('does not let unsigned traffic consume the delivery budget', async () => {
    const h = start({ rateMax: 1 });
    for (let i = 0; i < 5; i += 1) {
      expect((await h.post(payloadJson(), { 'x-hub-signature-256': 'sha256=deadbeef' })).status).toBe(401);
    }
    expect((await h.post(payloadJson())).status).toBe(202);
  });

  it('returns a generic 500 when the handler throws, without the error text', async () => {
    const h = start({ fail: new Error(`handler exploded on ${SENTINEL}`) });
    const reply = await h.post(payloadJson());
    expect(reply.status).toBe(500);
    expect(await reply.text()).not.toContain(SENTINEL);
    expect(JSON.stringify(h.log)).not.toContain(SENTINEL);
    expect(h.log[0]).toMatchObject({ status: 500, outcome: 'handler_error', detail: 'Error' });
  });

  it('answers unknown paths and methods without touching the handler', async () => {
    const h = start();
    expect((await h.send('GET', '/webhook')).status).toBe(405);
    expect((await h.send('GET', '/')).status).toBe(404);
    expect((await h.send('POST', '/admin')).status).toBe(404);
    expect(h.handler).toHaveLength(0);
    expect(h.log.map((entry) => entry.outcome)).toEqual(['method_not_allowed', 'not_found', 'not_found']);
  });
});
