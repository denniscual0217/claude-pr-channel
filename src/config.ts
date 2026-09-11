import type { BotComments } from './events/normalize.js';
import type { CiEvents } from './channel/filter.js';

export const ENV = {
  commentAuthors: 'PR_CHANNEL_COMMENT_AUTHORS',
  botComments: 'PR_CHANNEL_BOT_COMMENTS',
  ciEvents: 'PR_CHANNEL_CI_EVENTS',
  requiredChecks: 'PR_CHANNEL_REQUIRED_CHECKS',
  maxPayloadBytes: 'PR_CHANNEL_MAX_PAYLOAD_BYTES',
  rateLimitMax: 'PR_CHANNEL_RATE_LIMIT_MAX',
  rateLimitWindowMs: 'PR_CHANNEL_RATE_LIMIT_WINDOW_MS',
  cacheDir: 'PR_CHANNEL_CACHE_DIR',
  sweep: 'PR_CHANNEL_SWEEP',
} as const;

export const DEFAULTS = {
  maxPayloadBytes: 1_048_576,
  rateLimitMax: 120,
  rateLimitWindowMs: 60_000,
  ciEvents: 'completed',
} as const;

export interface RateLimit {
  readonly maxDeliveries: number;
  readonly windowMs: number;
}

export interface Config {
  readonly maxPayloadBytes: number;
  readonly rateLimit: RateLimit;
  // GitHub payloads never say which checks a branch rule requires, so all-required-green
  // is derived from this list. Empty means it is never announced.
  readonly requiredChecks: readonly string[];
  readonly ciEvents: CiEvents;
  // Whose comments and reviews the session may act on. Anyone can write on a PR, and
  // acting on a comment means pushing code, so this is a trust boundary, not a filter.
  // null means every human author, which track() narrows to the gh login by default.
  readonly commentAuthors: ReadonlySet<string> | null;
  readonly botComments: BotComments;
  readonly cacheDir: string | null;
  readonly sweepEnabled: boolean;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

type Env = Readonly<Record<string, string | undefined>>;

export function loadConfig(env: Env = process.env): Config {
  return {
    maxPayloadBytes: intFromEnv(env, ENV.maxPayloadBytes, DEFAULTS.maxPayloadBytes, { min: 1 }),
    rateLimit: {
      maxDeliveries: intFromEnv(env, ENV.rateLimitMax, DEFAULTS.rateLimitMax, { min: 1 }),
      windowMs: intFromEnv(env, ENV.rateLimitWindowMs, DEFAULTS.rateLimitWindowMs, { min: 1 }),
    },
    requiredChecks: parseRequiredChecks(env[ENV.requiredChecks]),
    ciEvents: parseCiEvents(env[ENV.ciEvents]),
    commentAuthors: parseCommentAuthors(env[ENV.commentAuthors]),
    botComments: parseBotComments(env[ENV.botComments]),
    cacheDir: (env[ENV.cacheDir] ?? '').trim() || null,
    sweepEnabled: (env[ENV.sweep] ?? '').trim().toLowerCase() !== 'off',
  };
}

// The secret is generated in memory and never reaches a description, a log or a marker.
export function describeConfig(config: Config): Record<string, unknown> {
  return {
    maxPayloadBytes: config.maxPayloadBytes,
    rateLimit: { ...config.rateLimit },
    requiredChecks: [...config.requiredChecks],
    ciEvents: config.ciEvents,
    commentAuthors: config.commentAuthors === null ? null : [...config.commentAuthors],
    botComments: config.botComments,
    sweepEnabled: config.sweepEnabled,
  };
}

// Logins are compared lowercased: GitHub treats them case-insensitively and a payload
// can carry either casing.
export function parseCommentAuthors(raw: string | undefined): ReadonlySet<string> | null {
  if (raw === undefined) return null;
  const logins = raw
    .split(',')
    .map((login) => login.trim().toLowerCase())
    .filter((login) => login.length > 0);
  return logins.length > 0 ? new Set(logins) : null;
}

export function parseBotComments(raw: string | undefined): BotComments {
  const value = (raw ?? 'handle').trim().toLowerCase();
  if (value === 'handle' || value === 'ignore') return value;
  throw new ConfigError(`${ENV.botComments} must be "handle" or "ignore"`);
}

export function parseCiEvents(raw: string | undefined): CiEvents {
  const value = (raw ?? DEFAULTS.ciEvents).trim().toLowerCase();
  if (value === 'failures' || value === 'completed' || value === 'all') return value;
  throw new ConfigError(`${ENV.ciEvents} must be "failures", "completed" or "all"`);
}

export function parseRequiredChecks(raw: string | undefined): readonly string[] {
  return [...new Set((raw ?? '').split(',').map((name) => name.trim()).filter((name) => name.length > 0))];
}

export function intFromEnv(
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
