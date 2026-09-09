import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WebhookSecret } from '../config.js';
import { verifyWebhookSignature, type SignatureVerifier } from './signature.js';

const FAKE_SECRET = 'test-only-fake-secret';
const verifier: SignatureVerifier = {
  hmacSha256Hex: (raw) => createHmac('sha256', FAKE_SECRET).update(raw).digest('hex'),
};
const body = Buffer.from('{"action":"opened","number":7}', 'utf8');
const sign = (raw: Buffer): string => `sha256=${createHmac('sha256', FAKE_SECRET).update(raw).digest('hex')}`;

describe('verifyWebhookSignature', () => {
  it('accepts a genuine signature over the raw body', () => {
    expect(verifyWebhookSignature(body, sign(body), verifier)).toEqual({ ok: true });
  });

  it('accepts an upper-case hex digest', () => {
    const header = sign(body);
    expect(verifyWebhookSignature(body, `sha256=${header.slice(7).toUpperCase()}`, verifier)).toEqual({ ok: true });
  });

  it('is interchangeable with the config WebhookSecret', () => {
    expect(verifyWebhookSignature(body, sign(body), new WebhookSecret(FAKE_SECRET))).toEqual({ ok: true });
  });

  it('rejects a tampered body', () => {
    const tampered = Buffer.from('{"action":"opened","number":8}', 'utf8');
    expect(verifyWebhookSignature(tampered, sign(body), verifier)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a signature made with a different secret', () => {
    const other = `sha256=${createHmac('sha256', 'another-fake-secret').update(body).digest('hex')}`;
    expect(verifyWebhookSignature(body, other, verifier)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a missing or empty header', () => {
    expect(verifyWebhookSignature(body, undefined, verifier)).toEqual({ ok: false, reason: 'missing_header' });
    expect(verifyWebhookSignature(body, '', verifier)).toEqual({ ok: false, reason: 'missing_header' });
  });

  it('rejects a non-string header without throwing', () => {
    expect(verifyWebhookSignature(body, ['sha256=a', 'sha256=b'], verifier)).toEqual({ ok: false, reason: 'malformed_header' });
    expect(verifyWebhookSignature(body, 42, verifier)).toEqual({ ok: false, reason: 'malformed_header' });
  });

  it('rejects the wrong algorithm prefix', () => {
    const digest = sign(body).slice(7);
    expect(verifyWebhookSignature(body, `sha1=${digest}`, verifier)).toEqual({ ok: false, reason: 'wrong_prefix' });
    expect(verifyWebhookSignature(body, digest, verifier)).toEqual({ ok: false, reason: 'wrong_prefix' });
  });

  it('rejects a wrong-length digest instead of letting timingSafeEqual throw', () => {
    expect(() => verifyWebhookSignature(body, 'sha256=abc', verifier)).not.toThrow();
    expect(verifyWebhookSignature(body, 'sha256=abc', verifier)).toEqual({ ok: false, reason: 'wrong_length' });
    expect(verifyWebhookSignature(body, `${sign(body)}00`, verifier)).toEqual({ ok: false, reason: 'wrong_length' });
    expect(verifyWebhookSignature(body, 'sha256=', verifier)).toEqual({ ok: false, reason: 'wrong_length' });
  });

  it('rejects a right-length digest that is not hex', () => {
    const notHex = `sha256=${'z'.repeat(64)}`;
    expect(verifyWebhookSignature(body, notHex, verifier)).toEqual({ ok: false, reason: 'malformed_header' });
  });

  it('does not consult the verifier when the header is unusable', () => {
    let calls = 0;
    const counting: SignatureVerifier = { hmacSha256Hex: (raw) => (calls++, verifier.hmacSha256Hex(raw)) };
    verifyWebhookSignature(body, undefined, counting);
    verifyWebhookSignature(body, 'sha1=x', counting);
    verifyWebhookSignature(body, 'sha256=short', counting);
    expect(calls).toBe(0);
    verifyWebhookSignature(body, sign(body), counting);
    expect(calls).toBe(1);
  });
});
