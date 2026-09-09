import { isAbsolute, join } from 'node:path';
import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULTS,
  ENV,
  describeConfig,
  isRepoAllowed,
  loadConfig,
  loadWebhookSecret,
  WebhookSecret,
} from './config.js';

const FAKE_SECRET = 'test-only-fake-secret';
const base = { [ENV.repoAllowlist]: 'Toptal/Some-Repo' };

describe('loadConfig', () => {
  it('applies loopback defaults and normalizes the allowlist', () => {
    const config = loadConfig(base);
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(DEFAULTS.port);
    expect(config.maxPayloadBytes).toBe(DEFAULTS.maxPayloadBytes);
    expect(config.rateLimit).toEqual({ maxDeliveries: DEFAULTS.rateLimitMax, windowMs: DEFAULTS.rateLimitWindowMs });
    expect(config.leaseTimeoutMs).toBe(DEFAULTS.leaseTimeoutMs);
    // Absolute, so the dispatcher and the registration CLI agree on one database no
    // matter which checkout each is run from.
    expect(isAbsolute(config.dbPath)).toBe(true);
    expect(config.dbPath.endsWith(join('.claude-pr-channel', 'channel.db'))).toBe(true);
    expect(isRepoAllowed(config, 'toptal/some-repo')).toBe(true);
    expect(isRepoAllowed(config, 'TOPTAL/Some-Repo')).toBe(true);
    expect(isRepoAllowed(config, 'toptal/other')).toBe(false);
    expect(config.requiredChecks).toEqual([]);
  });

  it('parses the required-check list into trimmed unique names', () => {
    const config = loadConfig({ ...base, [ENV.requiredChecks]: ' ci/lint , ci/test ,, ci/lint ' });
    expect(config.requiredChecks).toEqual(['ci/lint', 'ci/test']);
  });

  it('requires a non-empty allowlist of owner/name entries', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ [ENV.repoAllowlist]: 'not-a-repo' })).toThrow(/owner\/name/);
  });

  it('refuses a non-loopback host unless explicitly allowed', () => {
    expect(() => loadConfig({ ...base, [ENV.host]: '0.0.0.0' })).toThrow(/loopback/);
    expect(loadConfig({ ...base, [ENV.host]: '0.0.0.0', [ENV.allowNonLoopback]: 'true' }).host).toBe('0.0.0.0');
  });

  it('validates integer ranges', () => {
    expect(() => loadConfig({ ...base, [ENV.port]: '70000' })).toThrow(/between 1 and 65535/);
    expect(() => loadConfig({ ...base, [ENV.maxPayloadBytes]: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, [ENV.leaseTimeoutMs]: '0' })).toThrow(ConfigError);
    expect(loadConfig({ ...base, [ENV.port]: '9999' }).port).toBe(9999);
  });

  it('never includes the secret in a description', () => {
    const description = JSON.stringify(describeConfig(loadConfig({ ...base, [ENV.webhookSecret]: FAKE_SECRET })));
    expect(description).not.toContain(FAKE_SECRET);
    expect(description).toContain('[redacted]');
  });
});

describe('WebhookSecret', () => {
  it('is required and non-empty', () => {
    expect(() => loadWebhookSecret({})).toThrow(/not set/);
    expect(() => loadWebhookSecret({ [ENV.webhookSecret]: '' })).toThrow(/not set/);
    expect(loadWebhookSecret({ [ENV.webhookSecret]: FAKE_SECRET })).toBeInstanceOf(WebhookSecret);
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
});
