import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { ConfigSchema, NULLABLE_PATHS, TRACK_INPUT_KEYS, TrackInputSchema, configJsonSchema } from './config-schema.js';
import type { CiEvents, DeliveryPolicy, WorkflowWake } from './channel/filter.js';
import type { TrackInput } from './channel/tracking.js';
import type { BotComments } from './events/normalize.js';
import type { PrLifecycleAction } from './types.js';

export type AuthorsMode = 'operator' | 'listed' | 'anyone';

export interface RateLimit {
  readonly maxDeliveries: number;
  readonly windowMs: number;
}

// Mirrors schema/config.schema.json exactly. Pure data: nothing here is resolved against
// the environment, the gh login or a track argument.
export interface Config {
  readonly $schema?: string | undefined;
  readonly version: 1;
  readonly events: {
    readonly comments: { readonly enabled: boolean };
    readonly reviews: { readonly enabled: boolean };
    readonly reviewComments: { readonly enabled: boolean };
    readonly checks: { readonly enabled: boolean; readonly wake: CiEvents };
    readonly workflows: readonly { readonly name: string; readonly wake: WorkflowWake }[];
    readonly lifecycle: Readonly<Record<PrLifecycleAction, boolean>>;
  };
  readonly authors: {
    readonly mode: AuthorsMode;
    readonly allow: readonly string[];
    readonly bots: BotComments;
  };
  readonly limits: {
    readonly maxPayloadBytes: number;
    readonly rateLimit: RateLimit;
  };
  readonly cache: {
    readonly dir: string | null;
    readonly sweepOnTrack: boolean;
  };
}

export const DEFAULT_CONFIG: Config = {
  version: 1,
  events: {
    comments: { enabled: true },
    reviews: { enabled: true },
    reviewComments: { enabled: true },
    checks: { enabled: false, wake: 'completed' },
    workflows: [],
    lifecycle: {
      opened: true,
      synchronize: true,
      ready_for_review: true,
      converted_to_draft: true,
      reopened: true,
      closed: true,
      merged: true,
      labeled: false,
      unlabeled: false,
      assigned: false,
      unassigned: false,
      review_requested: false,
      review_request_removed: false,
      edited: false,
      milestoned: false,
      demilestoned: false,
      locked: false,
      unlocked: false,
      auto_merge_enabled: false,
      auto_merge_disabled: false,
      enqueued: false,
      dequeued: false,
    },
  },
  authors: { mode: 'operator', allow: [], bots: 'handle' },
  limits: { maxPayloadBytes: 1_048_576, rateLimit: { maxDeliveries: 120, windowMs: 60_000 } },
  cache: { dir: null, sweepOnTrack: true },
};

// The zod tree and this interface cannot drift: a key the schema produces that Config
// does not declare stops compiling here.
type _SchemaMatchesConfig = z.infer<typeof ConfigSchema> extends Config ? true : never;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

type Env = Readonly<Record<string, string | undefined>>;

// Returns null when there is no such file. Anything else it cannot read, it throws.
export type ConfigReader = (path: string) => string | null;

export type ConfigLoad =
  | { readonly ok: true; readonly config: Config; readonly path: string; readonly source: 'file' | 'defaults' }
  | { readonly ok: false; readonly path: string; readonly error: ConfigError };

export const CONFIG_PATH_ENV = 'PR_CHANNEL_CONFIG';

// The nine settings that used to be environment variables. Two sources for one value, in
// two syntaxes, is how a UI writes a file and nothing changes because a forgotten export
// wins — so they are refused by name rather than quietly ignored.
export const LEGACY_ENV: Readonly<Record<string, string>> = {
  PR_CHANNEL_COMMENT_AUTHORS: 'authors.mode / authors.allow',
  PR_CHANNEL_BOT_COMMENTS: 'authors.bots',
  PR_CHANNEL_CI_EVENTS: 'events.checks.wake',
  PR_CHANNEL_MAX_PAYLOAD_BYTES: 'limits.maxPayloadBytes',
  PR_CHANNEL_RATE_LIMIT_MAX: 'limits.rateLimit.maxDeliveries',
  PR_CHANNEL_RATE_LIMIT_WINDOW_MS: 'limits.rateLimit.windowMs',
  PR_CHANNEL_CACHE_DIR: 'cache.dir',
  PR_CHANNEL_SWEEP: 'cache.sweepOnTrack',
};

// Throws rather than falling back when there is no home to derive from: an empty HOME
// used to join into a relative ".config/...", which resolves against the working
// directory. Under a service manager, which passes no HOME, that silently pointed the
// editor at a different file from the one the plugin reads — edits appeared to save and
// then did nothing.
export function configPath(env: Env = process.env): string {
  const explicit = (env[CONFIG_PATH_ENV] ?? '').trim();
  if (explicit !== '') return explicit;
  const xdg = (env['XDG_CONFIG_HOME'] ?? '').trim();
  const home = (env['HOME'] ?? '').trim();
  if (xdg === '' && home === '') {
    throw new ConfigError(
      `cannot locate the configuration file: neither HOME nor XDG_CONFIG_HOME is set.\n` +
        `Set ${CONFIG_PATH_ENV} to an absolute path, or set HOME. A service unit must set one of them explicitly.`,
    );
  }
  return join(xdg || join(home, '.config'), 'claude-pr-channel', 'config.json');
}

export function schemaPath(pluginRoot: string): string {
  return join(pluginRoot, 'schema', 'config.schema.json');
}

export interface LoadConfigOptions {
  readonly env?: Env;
  readonly readFile?: ConfigReader;
}

export function loadConfig(options: LoadConfigOptions = {}): ConfigLoad {
  const env = options.env ?? process.env;
  const path = configPath(env);
  const read = options.readFile ?? defaultReader;

  const legacy = legacyProblems(env, path);
  if (legacy.length > 0) return { ok: false, path, error: new ConfigError(legacy.join('\n')) };

  let raw: string | null;
  try {
    raw = read(path);
  } catch (error) {
    return {
      ok: false,
      path,
      error: new ConfigError(`${file(path)}: could not be read: ${error instanceof Error ? error.message : 'unknown error'}`),
    };
  }

  if (raw === null) {
    if ((env[CONFIG_PATH_ENV] ?? '').trim() !== '') {
      return {
        ok: false,
        path,
        error: new ConfigError(`${file(path)}: no file at ${path}; ${CONFIG_PATH_ENV} names a file that must exist`),
      };
    }
    return { ok: true, config: DEFAULT_CONFIG, path, source: 'defaults' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      path,
      error: new ConfigError(`${file(path)}: not valid JSON: ${error instanceof Error ? error.message : 'unparseable'}`),
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, path, error: new ConfigError(`${file(path)}: expected a JSON object at the top level`) };
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, path, error: new ConfigError(explain(result.error.issues, parsed, file(path), knownKeysAt)) };
  }
  return { ok: true, config: result.data, path, source: 'file' };
}

// No secret is ever configurable: the webhook secret is generated per track in memory.
// This stays as the guarantee that a description of the config cannot leak one anyway.
export function describeConfig(config: Config): Record<string, unknown> {
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}

function defaultReader(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function legacyProblems(env: Env, path: string): string[] {
  return Object.entries(LEGACY_ENV)
    .filter(([name]) => env[name] !== undefined)
    .map(([name, key]) => `${name} is no longer read; set ${key} in ${path}`);
}

function file(path: string): string {
  return path.split('/').pop() || path;
}

interface Issue {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly keys?: readonly string[];
  readonly expected?: string;
  readonly values?: readonly unknown[];
  readonly minimum?: unknown;
  readonly maximum?: unknown;
  // zod sets this on too_small / too_big to say what was measured: a string's length, an
  // array's, or a number's value. Without it the two read identically.
  readonly origin?: string;
}

// Shared by the config file and by the track arguments: one wording for "this value is
// wrong", whichever layer of the precedence chain it came from.
function explain(
  issues: readonly Issue[],
  raw: unknown,
  rootLabel: string,
  knownKeys: (path: readonly PropertyKey[]) => string[],
): string {
  const lines: string[] = [];
  for (const issue of issues) {
    const key = issue.path.map(String).join('.');
    // A problem with the whole thing has no key to name, so it is reported against
    // whatever holds it: the file, or the call's arguments.
    const label = key === '' ? rootLabel : key;
    switch (issue.code) {
      case 'unrecognized_keys':
        for (const unknownKey of issue.keys ?? []) {
          lines.push(`${label}: unknown key "${unknownKey}"; known keys: ${knownKeys(issue.path).join(', ')}`);
        }
        break;
      // A string and a number are both "too small", and saying "expected an integer" about
      // a blank name is a lie that sends the reader looking for the wrong mistake.
      case 'too_small':
        lines.push(
          issue.origin === 'string' || issue.origin === 'array'
            ? `${label}: ${show(valueAt(raw, issue.path))} is too short; expected at least ${String(issue.minimum)} ${unit(issue.origin, issue.minimum)}`
            : `${label}: ${show(valueAt(raw, issue.path))} is too small; expected an integer >= ${String(issue.minimum)}`,
        );
        break;
      case 'too_big':
        lines.push(
          issue.origin === 'string' || issue.origin === 'array'
            ? `${label}: ${show(valueAt(raw, issue.path))} is too long; expected at most ${String(issue.maximum)} ${unit(issue.origin, issue.maximum)}`
            : `${label}: ${show(valueAt(raw, issue.path))} is too big; expected an integer <= ${String(issue.maximum)}`,
        );
        break;
      case 'invalid_value':
        lines.push(`${label}: ${show(valueAt(raw, issue.path))} is not allowed; expected ${options(issue.values ?? [])}`);
        break;
      case 'invalid_type':
        lines.push(`${label}: ${show(valueAt(raw, issue.path))} is not valid; expected ${expected(key, issue.expected)}`);
        break;
      default:
        lines.push(`${label}: ${issue.message}`);
    }
  }
  return lines.join('\n');
}

function show(value: unknown): string {
  if (value === undefined) return 'nothing';
  return JSON.stringify(value) ?? String(value);
}

function unit(origin: string, count: unknown): string {
  const noun = origin === 'array' ? 'item' : 'character';
  return Number(count) === 1 ? noun : `${noun}s`;
}

function options(values: readonly unknown[]): string {
  if (values.length === 1) return JSON.stringify(values[0]) ?? String(values[0]);
  return `one of ${values.map((value) => JSON.stringify(value)).join(', ')}`;
}

const TYPE_WORDS: Readonly<Record<string, string>> = {
  boolean: 'a boolean',
  string: 'a string',
  int: 'an integer',
  number: 'a number',
  array: 'an array',
  object: 'an object',
  null: 'null',
};

function expected(key: string, raw: string | undefined): string {
  const word = raw === undefined ? 'a different type' : TYPE_WORDS[raw] ?? `a ${raw}`;
  return NULLABLE_PATHS.has(key) ? `${word} or null` : word;
}

function valueAt(raw: unknown, path: readonly PropertyKey[]): unknown {
  let cursor: unknown = raw;
  for (const step of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<PropertyKey, unknown>)[step];
  }
  return cursor;
}

let cachedSchema: Record<string, unknown> | null = null;

// Taken from the generated JSON Schema rather than a second hand-written list, so the
// "known keys" a user is shown are exactly the ones the validator accepts.
function knownKeysAt(path: readonly PropertyKey[]): string[] {
  cachedSchema ??= configJsonSchema();
  let node: Record<string, unknown> | undefined = cachedSchema;
  for (const step of path) {
    const properties = node?.['properties'] as Record<string, Record<string, unknown>> | undefined;
    node = properties?.[String(step)];
    if (node === undefined) return [];
  }
  return Object.keys((node?.['properties'] as Record<string, unknown>) ?? {});
}

export type SettingOrigin = 'argument' | 'config' | 'default';

export interface EffectiveSettings {
  readonly policy: DeliveryPolicy;
  // null means every human author. A trust boundary, applied during normalization.
  readonly commentAuthors: ReadonlySet<string> | null;
  readonly botComments: BotComments;
  readonly workflowNames: ReadonlySet<string>;
  readonly limits: Config['limits'];
  readonly cache: Config['cache'];
  readonly origins: {
    readonly ciEvents: SettingOrigin;
    readonly commentAuthors: SettingOrigin;
    readonly botComments: SettingOrigin;
  };
}

export type TrackInputParse =
  | { readonly ok: true; readonly input: TrackInput }
  | { readonly ok: false; readonly message: string };

// The top layer of the precedence chain, checked as hard as the file below it. MCP hands
// a tool whatever the model emitted: the enums the track tool advertises are never
// enforced by the transport, so an unchecked "Ignore" would reach the filters as a value
// nothing matches — read as its opposite by senderAllowed, and still reported as in force
// on the filters: line. A wrong value is refused and named here instead.
export function parseTrackInput(raw: unknown): TrackInputParse {
  const result = TrackInputSchema.safeParse(raw ?? {});
  if (!result.success) {
    return { ok: false, message: explain(result.error.issues, raw, 'arguments', () => [...TRACK_INPUT_KEYS]) };
  }
  return { ok: true, input: result.data };
}

// The one place precedence lives: a track argument, then the config file, then the
// built-in default. A value equal to the built-in default is reported as coming from the
// default, whether or not the file happens to spell it out.
export function resolveTracking(config: Config, input: TrackInput, ghLogin: string | null): EffectiveSettings {
  const events = config.events;
  const wake: CiEvents = input.ci_events ?? events.checks.wake;
  const botComments: BotComments = input.bot_comments ?? config.authors.bots;

  return {
    policy: {
      comments: events.comments.enabled,
      reviews: events.reviews.enabled,
      reviewComments: events.reviewComments.enabled,
      checks: { enabled: events.checks.enabled, wake },
      workflows: new Map(events.workflows.map((entry) => [entry.name, entry.wake])),
      lifecycle: events.lifecycle,
    },
    commentAuthors: resolveCommentAuthors(config, input.comment_authors, ghLogin),
    botComments,
    workflowNames: new Set(events.workflows.map((entry) => entry.name)),
    limits: config.limits,
    cache: config.cache,
    origins: {
      ciEvents: origin(input.ci_events !== undefined, wake === DEFAULT_CONFIG.events.checks.wake),
      commentAuthors: origin(input.comment_authors !== undefined, config.authors.mode === DEFAULT_CONFIG.authors.mode),
      botComments: origin(input.bot_comments !== undefined, botComments === DEFAULT_CONFIG.authors.bots),
    },
  };
}

function origin(fromArgument: boolean, isBuiltInDefault: boolean): SettingOrigin {
  if (fromArgument) return 'argument';
  return isBuiltInDefault ? 'default' : 'config';
}

// Logins are compared lowercased: GitHub treats them case-insensitively and a payload can
// carry either casing.
function resolveCommentAuthors(
  config: Config,
  fromInput: readonly string[] | undefined,
  ghLogin: string | null,
): ReadonlySet<string> | null {
  if (fromInput !== undefined) {
    const logins = fromInput.map((login) => login.trim().toLowerCase()).filter((login) => login.length > 0);
    return logins.length > 0 ? new Set(logins) : null;
  }
  switch (config.authors.mode) {
    case 'anyone':
      return null;
    case 'listed':
      return new Set(config.authors.allow);
    case 'operator':
      // Acting on a comment means pushing code, so the default trusts only the account
      // this machine is authenticated as.
      return ghLogin === null || ghLogin.trim() === '' ? null : new Set([ghLogin.trim().toLowerCase()]);
  }
}
