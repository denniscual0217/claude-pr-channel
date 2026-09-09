import { createHmac, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspect } from 'node:util';

export const ENV = {
  host: 'PR_CHANNEL_HOST',
  port: 'PR_CHANNEL_PORT',
  repoAllowlist: 'PR_CHANNEL_REPO_ALLOWLIST',
  commentAuthors: 'PR_CHANNEL_COMMENT_AUTHORS',
  delivery: 'PR_CHANNEL_DELIVERY',
  maxPayloadBytes: 'PR_CHANNEL_MAX_PAYLOAD_BYTES',
  rateLimitMax: 'PR_CHANNEL_RATE_LIMIT_MAX',
  rateLimitWindowMs: 'PR_CHANNEL_RATE_LIMIT_WINDOW_MS',
  dbPath: 'PR_CHANNEL_DB_PATH',
  leaseTimeoutMs: 'PR_CHANNEL_LEASE_TIMEOUT_MS',
  requiredChecks: 'PR_CHANNEL_REQUIRED_CHECKS',
  allowNonLoopback: 'PR_CHANNEL_ALLOW_NON_LOOPBACK',
  webhookSecret: 'GITHUB_WEBHOOK_SECRET',
} as const;

export const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  maxPayloadBytes: 1_048_576,
  rateLimitMax: 120,
  rateLimitWindowMs: 60_000,
  // Absolute on purpose: the dispatcher runs from its own directory while the
  // registration CLI runs from whatever checkout the worker is in. A relative default
  // would give them two different databases and registration would silently go nowhere.
  dbPath: join(homedir(), '.claude-pr-channel', 'channel.db'),
  leaseTimeoutMs: 60_000,
} as const;

export interface RateLimit {
  readonly maxDeliveries: number;
  readonly windowMs: number;
}

export interface ServiceConfig {
  readonly host: string;
  readonly port: number;
  readonly repoAllowlist: ReadonlySet<string>;
  readonly maxPayloadBytes: number;
  readonly rateLimit: RateLimit;
  readonly dbPath: string;
  readonly leaseTimeoutMs: number;
  // GitHub payloads never say which checks a branch rule requires, so all-required-green
  // is derived from this list. Empty means the dispatcher never announces it.
  readonly requiredChecks: readonly string[];
  // Whose comments and reviews the session may act on. Anyone can write on a PR, and
  // acting on a comment means pushing code, so this is a trust boundary, not a filter:
  // a colleague's review should wait for a human. null means every human author is
  // allowed, which is only appropriate on a repo where that is already true.
  readonly commentAuthors: ReadonlySet<string> | null;
  // How a queued event reaches its session. 'channel' means a Claude Code channel is
  // attached and pushes into the live session; the dispatcher must not also spawn a
  // courier, or the two race for the same queue.
  readonly delivery: DeliveryMode;
}

export type DeliveryMode = 'courier' | 'channel';

// Logins are compared lowercased: GitHub treats them case-insensitively and a payload
// can carry either casing.
function parseCommentAuthors(raw: string | undefined): ReadonlySet<string> | null {
  if (raw === undefined) return null;
  const logins = raw
    .split(',')
    .map((login) => login.trim().toLowerCase())
    .filter((login) => login.length > 0);
  return logins.length > 0 ? new Set(logins) : null;
}

function parseDelivery(raw: string | undefined): DeliveryMode {
  const value = (raw ?? 'courier').trim().toLowerCase();
  if (value === 'courier' || value === 'channel') return value;
  throw new ConfigError(`${ENV.delivery} must be "courier" or "channel"`);
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

type Env = Readonly<Record<string, string | undefined>>;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function loadConfig(env: Env = process.env): ServiceConfig {
  const host = (env[ENV.host] ?? DEFAULTS.host).trim();
  const allowNonLoopback = env[ENV.allowNonLoopback] === 'true';
  if (!LOOPBACK_HOSTS.has(host) && !allowNonLoopback) {
    throw new ConfigError(
      `${ENV.host}=${host} is not a loopback address; set ${ENV.allowNonLoopback}=true to bind it anyway`,
    );
  }

  return {
    host,
    port: intFromEnv(env, ENV.port, DEFAULTS.port, { min: 1, max: 65_535 }),
    repoAllowlist: parseRepoAllowlist(env[ENV.repoAllowlist]),
    commentAuthors: parseCommentAuthors(env[ENV.commentAuthors]),
    delivery: parseDelivery(env[ENV.delivery]),
    maxPayloadBytes: intFromEnv(env, ENV.maxPayloadBytes, DEFAULTS.maxPayloadBytes, { min: 1 }),
    rateLimit: {
      maxDeliveries: intFromEnv(env, ENV.rateLimitMax, DEFAULTS.rateLimitMax, { min: 1 }),
      windowMs: intFromEnv(env, ENV.rateLimitWindowMs, DEFAULTS.rateLimitWindowMs, { min: 1 }),
    },
    dbPath: resolve((env[ENV.dbPath] ?? DEFAULTS.dbPath).trim() || DEFAULTS.dbPath),
    leaseTimeoutMs: intFromEnv(env, ENV.leaseTimeoutMs, DEFAULTS.leaseTimeoutMs, { min: 1 }),
    requiredChecks: parseRequiredChecks(env[ENV.requiredChecks]),
  };
}

export function isRepoAllowed(config: ServiceConfig, repo: string): boolean {
  return config.repoAllowlist.has(normalizeRepo(repo));
}

export function normalizeRepo(repo: string): string {
  return repo.trim().toLowerCase();
}

export function describeConfig(config: ServiceConfig): Record<string, unknown> {
  return {
    host: config.host,
    port: config.port,
    repoAllowlist: [...config.repoAllowlist],
    commentAuthors: config.commentAuthors === null ? null : [...config.commentAuthors],
    delivery: config.delivery,
    maxPayloadBytes: config.maxPayloadBytes,
    rateLimit: { ...config.rateLimit },
    dbPath: config.dbPath,
    leaseTimeoutMs: config.leaseTimeoutMs,
    requiredChecks: [...config.requiredChecks],
    webhookSecret: '[redacted]',
  };
}

// The raw secret never leaves this class: callers get an HMAC or a verdict, not the value.
export class WebhookSecret {
  readonly #value: Buffer;

  constructor(value: string) {
    if (value.length === 0) throw new ConfigError(`${ENV.webhookSecret} is empty`);
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

export function loadWebhookSecret(env: Env = process.env): WebhookSecret {
  const value = env[ENV.webhookSecret];
  if (value === undefined || value.length === 0) {
    throw new ConfigError(`${ENV.webhookSecret} is not set`);
  }
  return new WebhookSecret(value);
}

function parseRepoAllowlist(raw: string | undefined): ReadonlySet<string> {
  const entries = (raw ?? '')
    .split(',')
    .map(normalizeRepo)
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    throw new ConfigError(`${ENV.repoAllowlist} must list at least one owner/name repository`);
  }
  for (const entry of entries) {
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(entry)) {
      throw new ConfigError(`${ENV.repoAllowlist} entry "${entry}" is not of the form owner/name`);
    }
  }
  return new Set(entries);
}

function parseRequiredChecks(raw: string | undefined): readonly string[] {
  return [...new Set((raw ?? '').split(',').map((name) => name.trim()).filter((name) => name.length > 0))];
}

function intFromEnv(
  env: Env,
  name: string,
  fallback: number,
  range: { min: number; max?: number },
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < range.min || (range.max !== undefined && value > range.max)) {
    const bound = range.max === undefined ? `>= ${range.min}` : `between ${range.min} and ${range.max}`;
    throw new ConfigError(`${name} must be an integer ${bound}, got "${raw}"`);
  }
  return value;
}
