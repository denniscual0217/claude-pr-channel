import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { inspect } from 'node:util';

// The raw secret never leaves this class: callers get an HMAC or a verdict, not the value.
export class WebhookSecret {
  readonly #value: Buffer;

  constructor(value: string) {
    if (value.length === 0) throw new Error('webhook secret is empty');
    this.#value = Buffer.from(value, 'utf8');
  }

  hmacSha256Hex(rawBody: Buffer): string {
    return createHmac('sha256', this.#value).update(rawBody).digest('hex');
  }

  verifySignature256(rawBody: Buffer, headerValue: string | undefined): boolean {
    if (typeof headerValue !== 'string' || !headerValue.startsWith('sha256=')) return false;
    const expected = Buffer.from(this.hmacSha256Hex(rawBody), 'utf8');
    const actual = Buffer.from(headerValue.slice('sha256='.length).toLowerCase(), 'utf8');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  // gh webhook forward only accepts the secret on its command line, so this is the one
  // place it is ever handed out, and only to the code that spawns gh.
  reveal(): string {
    return this.#value.toString('utf8');
  }

  toString(): string {
    return '[WebhookSecret redacted]';
  }

  toJSON(): string {
    return '[redacted]';
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

export function generateWebhookSecret(): WebhookSecret {
  return new WebhookSecret(randomBytes(32).toString('hex'));
}
