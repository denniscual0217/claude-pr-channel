import { describe, expect, it } from 'bun:test';
import { ConfigError, DEFAULTS, ENV, describeConfig, loadConfig } from './config.js';

const FAKE_SECRET = 'test-only-fake-secret';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig({});
    expect(config.maxPayloadBytes).toBe(DEFAULTS.maxPayloadBytes);
    expect(config.rateLimit).toEqual({ maxDeliveries: DEFAULTS.rateLimitMax, windowMs: DEFAULTS.rateLimitWindowMs });
    expect(config.requiredChecks).toEqual([]);
    expect(config.ciEvents).toBe('completed');
    expect(config.commentAuthors).toBeNull();
    expect(config.botComments).toBe('handle');
    expect(config.cacheDir).toBeNull();
    expect(config.sweepEnabled).toBe(true);
  });

  it('parses the required-check list into trimmed unique names', () => {
    expect(loadConfig({ [ENV.requiredChecks]: ' ci/lint , ci/test ,, ci/lint ' }).requiredChecks).toEqual([
      'ci/lint',
      'ci/test',
    ]);
  });

  it('lowercases comment authors, since GitHub logins are case-insensitive', () => {
    expect([...(loadConfig({ [ENV.commentAuthors]: 'Alice, BOB ' }).commentAuthors ?? [])]).toEqual(['alice', 'bob']);
    expect(loadConfig({ [ENV.commentAuthors]: '  ,  ' }).commentAuthors).toBeNull();
  });

  it('validates the enumerated settings', () => {
    expect(() => loadConfig({ [ENV.botComments]: 'maybe' })).toThrow(ConfigError);
    expect(() => loadConfig({ [ENV.ciEvents]: 'sometimes' })).toThrow(ConfigError);
    expect(loadConfig({ [ENV.ciEvents]: 'ALL' }).ciEvents).toBe('all');
  });

  it('validates integer ranges', () => {
    expect(() => loadConfig({ [ENV.maxPayloadBytes]: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ [ENV.rateLimitMax]: '0' })).toThrow(ConfigError);
    expect(loadConfig({ [ENV.maxPayloadBytes]: '9999' }).maxPayloadBytes).toBe(9999);
  });

  it('turns the sweep off only on the exact opt-out', () => {
    expect(loadConfig({ [ENV.sweep]: 'off' }).sweepEnabled).toBe(false);
    expect(loadConfig({ [ENV.sweep]: 'on' }).sweepEnabled).toBe(true);
  });

  // The secret is generated per track() in memory; nothing about it is configurable, and
  // no description may carry one that a caller passed in the environment anyway.
  it('never includes a secret in a description', () => {
    const description = JSON.stringify(
      describeConfig(loadConfig({ PR_CHANNEL_WEBHOOK_SECRET: FAKE_SECRET, GITHUB_WEBHOOK_SECRET: FAKE_SECRET })),
    );
    expect(description).not.toContain(FAKE_SECRET);
  });
});
