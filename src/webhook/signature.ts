import { timingSafeEqual } from 'node:crypto';

// Satisfied by config.ts's WebhookSecret; this module never sees the secret value.
export interface SignatureVerifier {
  hmacSha256Hex(rawBody: Buffer): string;
}

export type SignatureFailure =
  | 'missing_header'
  | 'malformed_header'
  | 'wrong_prefix'
  | 'wrong_length'
  | 'mismatch';

export type SignatureResult = { readonly ok: true } | { readonly ok: false; readonly reason: SignatureFailure };

export const SIGNATURE_HEADER = 'x-hub-signature-256';

const PREFIX = 'sha256=';
const HEX_DIGEST_LENGTH = 64;
const HEX = /^[0-9a-fA-F]+$/;

export function verifyWebhookSignature(
  rawBody: Buffer,
  headerValue: unknown,
  verifier: SignatureVerifier,
): SignatureResult {
  if (headerValue === undefined || headerValue === null || headerValue === '') return fail('missing_header');
  if (typeof headerValue !== 'string') return fail('malformed_header');
  if (!headerValue.startsWith(PREFIX)) return fail('wrong_prefix');

  const provided = headerValue.slice(PREFIX.length);
  // timingSafeEqual throws on unequal lengths; reject explicitly so that never surfaces as a 500.
  if (provided.length !== HEX_DIGEST_LENGTH) return fail('wrong_length');
  if (!HEX.test(provided)) return fail('malformed_header');

  const expected = Buffer.from(verifier.hmacSha256Hex(rawBody), 'utf8');
  const actual = Buffer.from(provided.toLowerCase(), 'utf8');
  if (expected.length !== actual.length) return fail('wrong_length');
  return timingSafeEqual(expected, actual) ? { ok: true } : fail('mismatch');
}

function fail(reason: SignatureFailure): SignatureResult {
  return { ok: false, reason };
}
