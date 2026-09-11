import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'bun:test';
import { WebhookSecret, generateWebhookSecret } from './secret.js';

const FAKE_SECRET = 'test-only-fake-secret';

describe('WebhookSecret', () => {
  it('is required and non-empty', () => {
    expect(() => new WebhookSecret('')).toThrow(/empty/);
    expect(new WebhookSecret(FAKE_SECRET)).toBeInstanceOf(WebhookSecret);
  });

  it('verifies a sha256= signature over the raw body and rejects tampering', () => {
    const secret = new WebhookSecret(FAKE_SECRET);
    const body = Buffer.from('{"action":"opened"}');
    const header = `sha256=${createHmac('sha256', FAKE_SECRET).update(body).digest('hex')}`;
    expect(secret.verifySignature256(body, header)).toBe(true);
    expect(secret.verifySignature256(body, header.toUpperCase().replace('SHA256=', 'sha256='))).toBe(true);
    expect(secret.verifySignature256(Buffer.from('{"action":"opened" }'), header)).toBe(false);
    expect(secret.verifySignature256(body, header.slice(0, -1))).toBe(false);
    expect(secret.verifySignature256(body, header.replace('sha256=', 'sha1='))).toBe(false);
    expect(secret.verifySignature256(body, undefined)).toBe(false);
    expect(new WebhookSecret('other-fake-secret').verifySignature256(body, header)).toBe(false);
  });

  it('never leaks its value through string, JSON, inspect, or errors', () => {
    const secret = new WebhookSecret(FAKE_SECRET);
    expect(String(secret)).not.toContain(FAKE_SECRET);
    expect(JSON.stringify({ secret })).not.toContain(FAKE_SECRET);
    expect(inspect(secret)).not.toContain(FAKE_SECRET);
    expect(Object.keys(secret)).toEqual([]);
    let message = '';
    try {
      new WebhookSecret('');
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/empty/);
  });

  it('generates a fresh 32-byte secret each time', () => {
    const first = generateWebhookSecret().reveal();
    const second = generateWebhookSecret().reveal();
    expect(first).toHaveLength(64);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
  });
});
