import { describe, expect, it } from 'bun:test';
import { ALLOWED_GITHUB_EVENTS } from '../types.js';
import {
  checkDeclaredLength,
  DeliveryRateLimiter,
  extractRepoFullName,
  isAllowedEventName,
  parseDeliveryId,
} from './limits.js';

describe('checkDeclaredLength', () => {
  it('passes absent or in-range lengths and flags oversized or malformed ones', () => {
    expect(checkDeclaredLength(undefined, 10)).toBe('ok');
    expect(checkDeclaredLength('10', 10)).toBe('ok');
    expect(checkDeclaredLength('11', 10)).toBe('too_large');
    expect(checkDeclaredLength('99999999999999999999999', 10)).toBe('invalid');
    expect(checkDeclaredLength('abc', 10)).toBe('invalid');
    expect(checkDeclaredLength(['1', '2'], 10)).toBe('invalid');
  });
});

describe('event and repo allowlists', () => {
  it('accepts exactly the allowlisted event names', () => {
    for (const name of ALLOWED_GITHUB_EVENTS) expect(isAllowedEventName(name)).toBe(true);
    expect(isAllowedEventName('push')).toBe(false);
    expect(isAllowedEventName('ping')).toBe(false);
    expect(isAllowedEventName('Pull_Request')).toBe(false);
    expect(isAllowedEventName(undefined)).toBe(false);
    expect(isAllowedEventName(['pull_request'])).toBe(false);
  });

  it('extracts repository.full_name only from a well-formed payload', () => {
    expect(extractRepoFullName({ repository: { full_name: 'Toptal/Repo' } })).toBe('Toptal/Repo');
    expect(extractRepoFullName({ repository: { full_name: '' } })).toBeNull();
    expect(extractRepoFullName({ repository: { full_name: 7 } })).toBeNull();
    expect(extractRepoFullName({ repository: null })).toBeNull();
    expect(extractRepoFullName({})).toBeNull();
    expect(extractRepoFullName('nope')).toBeNull();
    expect(extractRepoFullName(null)).toBeNull();
  });

});

describe('parseDeliveryId', () => {
  it('accepts GitHub-shaped ids and rejects anything else', () => {
    expect(parseDeliveryId('72d3162e-cc78-11e3-81ab-4c9367dc0958')).toBe('72d3162e-cc78-11e3-81ab-4c9367dc0958');
    expect(parseDeliveryId(undefined)).toBeNull();
    expect(parseDeliveryId('')).toBeNull();
    expect(parseDeliveryId('has space')).toBeNull();
    expect(parseDeliveryId('a'.repeat(65))).toBeNull();
    expect(parseDeliveryId(['a', 'b'])).toBeNull();
  });
});

describe('DeliveryRateLimiter', () => {
  it('trips after maxDeliveries within the window and recovers once it slides', () => {
    const limiter = new DeliveryRateLimiter({ maxDeliveries: 3, windowMs: 1000 });
    expect(limiter.tryAcquire(0)).toEqual({ allowed: true });
    expect(limiter.tryAcquire(100)).toEqual({ allowed: true });
    expect(limiter.tryAcquire(200)).toEqual({ allowed: true });
    expect(limiter.tryAcquire(300)).toEqual({ allowed: false, retryAfterMs: 700 });
    expect(limiter.tryAcquire(999)).toEqual({ allowed: false, retryAfterMs: 1 });
    expect(limiter.tryAcquire(1001)).toEqual({ allowed: true });
    expect(limiter.tryAcquire(1050)).toEqual({ allowed: false, retryAfterMs: 50 });
    expect(limiter.tryAcquire(1201)).toEqual({ allowed: true });
  });

  it('does not count rejected attempts against the window', () => {
    const limiter = new DeliveryRateLimiter({ maxDeliveries: 1, windowMs: 1000 });
    expect(limiter.tryAcquire(0).allowed).toBe(true);
    for (let t = 1; t < 1000; t += 100) expect(limiter.tryAcquire(t).allowed).toBe(false);
    expect(limiter.tryAcquire(1001).allowed).toBe(true);
  });
});
