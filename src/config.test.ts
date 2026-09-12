import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  CONFIG_PATH_ENV,
  DEFAULT_CONFIG,
  LEGACY_ENV,
  configPath,
  describeConfig,
  loadConfig,
  parseTrackInput,
  resolveTracking,
  type Config,
  type ConfigLoad,
} from './config.js';
import type { TrackInput } from './channel/tracking.js';

const FAKE_SECRET = 'test-only-fake-secret';
const FILE = '/cfg/claude-pr-channel/config.json';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Every load is given its own environment and its own reader, so nothing on this machine
// can change what a test sees.
function load(contents: string | null, env: Record<string, string | undefined> = {}): ConfigLoad {
  return loadConfig({
    env: { HOME: '/home/octo', [CONFIG_PATH_ENV]: FILE, ...env },
    readFile: () => contents,
  });
}

function loaded(contents: string): Config {
  const result = load(contents);
  if (!result.ok) throw new Error(result.error.message);
  return result.config;
}

function problem(contents: string | null, env: Record<string, string | undefined> = {}): string {
  const result = load(contents, env);
  if (result.ok) throw new Error('expected the config to be refused');
  return result.error.message;
}

describe('where the config file lives', () => {
  it('follows XDG, falling back to ~/.config', () => {
    expect(configPath({ HOME: '/home/octo' })).toBe('/home/octo/.config/claude-pr-channel/config.json');
    expect(configPath({ HOME: '/home/octo', XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/claude-pr-channel/config.json');
  });

  it('is overridden by PR_CHANNEL_CONFIG, which is a location and not a setting', () => {
    expect(configPath({ HOME: '/home/octo', XDG_CONFIG_HOME: '/xdg', [CONFIG_PATH_ENV]: '/tmp/pr.json' })).toBe(
      '/tmp/pr.json',
    );
  });
});

describe('loadConfig', () => {
  it('runs on defaults when there is no file at the default location, and says where it looked', () => {
    const result = loadConfig({ env: { HOME: '/home/octo' }, readFile: () => null });

    expect(result).toMatchObject({ ok: true, source: 'defaults', path: '/home/octo/.config/claude-pr-channel/config.json' });
    expect(result.ok && result.config).toEqual(DEFAULT_CONFIG);
  });

  // A path the user named is a path the user expects to exist.
  it('refuses a missing file that PR_CHANNEL_CONFIG named', () => {
    expect(problem(null)).toContain(`no file at ${FILE}`);
  });

  it('reads a real file from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-channel-config-'));
    dirs.push(dir);
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ cache: { sweepOnTrack: false } }), 'utf8');

    const result = loadConfig({ env: { HOME: dir, [CONFIG_PATH_ENV]: path } });

    expect(result).toMatchObject({ ok: true, source: 'file', path });
    expect(result.ok && result.config.cache).toEqual({ dir: null, sweepOnTrack: false });
  });

  it('accepts the minimal file, and version 1 spelled out', () => {
    expect(loaded('{}')).toEqual(DEFAULT_CONFIG);
    expect(loaded('{"version": 1}')).toEqual(DEFAULT_CONFIG);
  });

  // zod's .default({}) hands the empty object straight back and leaves every child unset;
  // .prefault({}) is what fills them, and this is the tripwire for that.
  it('fills the children of an object the file only half-specifies', () => {
    const config = loaded('{"events": {"checks": {"wake": "failures"}}}');

    expect(config.events.checks).toEqual({ enabled: true, wake: 'failures' });
    expect(config.events.comments).toEqual({ enabled: true });
    expect(config.events.lifecycle).toEqual(DEFAULT_CONFIG.events.lifecycle);
    expect(config.limits).toEqual(DEFAULT_CONFIG.limits);
  });

  it('ignores $schema, which is there for editors', () => {
    expect(loaded('{"$schema": "./schema/config.schema.json"}').events).toEqual(DEFAULT_CONFIG.events);
  });

  it('trims and dedupes required-check names and author logins', () => {
    const config = loaded(
      '{"events": {"requiredChecks": {"names": [" ci/lint ", "ci/test", "ci/lint", ""]}},' +
        ' "authors": {"mode": "listed", "allow": ["Alice", "alice ", "BOB"]}}',
    );

    expect(config.events.requiredChecks.names).toEqual(['ci/lint', 'ci/test']);
    expect(config.authors.allow).toEqual(['alice', 'bob']);
  });
});

describe('a config that cannot be used', () => {
  it('never falls back to defaults on bad JSON, and carries the parser\'s own words', () => {
    const message = problem('{ "events": }');

    expect(message).toContain('config.json: not valid JSON:');
    expect(message.length).toBeGreaterThan('config.json: not valid JSON:'.length);
  });

  it('refuses a top-level array', () => {
    expect(problem('[]')).toBe('config.json: expected a JSON object at the top level');
  });

  it('names an unknown key and lists the keys that would have worked', () => {
    expect(problem('{"evens": {}}')).toContain('config.json: unknown key "evens"; known keys: $schema, version, events');

    const nested = problem('{"events": {"lifecycle": {"labled": true}}}');
    expect(nested).toContain('events.lifecycle: unknown key "labled"; known keys: opened, synchronize');
    expect(nested).toContain('labeled');
  });

  it('names the key, what it got and what it expected', () => {
    expect(problem('{"limits": {"maxPayloadBytes": 0}}')).toBe(
      'limits.maxPayloadBytes: 0 is too small; expected an integer >= 1',
    );
    expect(problem('{"limits": {"maxPayloadBytes": 99999999}}')).toContain('is too big; expected an integer <= 26214400');
    expect(problem('{"events": {"checks": {"wake": "sometimes"}}}')).toBe(
      'events.checks.wake: "sometimes" is not allowed; expected one of "failures", "completed", "all"',
    );
    expect(problem('{"events": {"comments": {"enabled": "yes"}}}')).toBe(
      'events.comments.enabled: "yes" is not valid; expected a boolean',
    );
    expect(problem('{"cache": {"dir": 7}}')).toBe('cache.dir: 7 is not valid; expected a string or null');
    expect(problem('{"version": 2}')).toBe('version: 2 is not allowed; expected 1');
  });

  it('refuses a deploy workflow that is enabled without a name', () => {
    for (const file of [
      '{"events": {"deployWorkflow": {"enabled": true}}}',
      '{"events": {"deployWorkflow": {"enabled": true, "workflowName": "  "}}}',
    ]) {
      expect(problem(file)).toBe(
        'events.deployWorkflow.workflowName: required when events.deployWorkflow.enabled is true; ' +
          'expected the exact name of a GitHub Actions workflow',
      );
    }
  });

  it('refuses the listed author mode with nobody listed', () => {
    expect(problem('{"authors": {"mode": "listed"}}')).toBe(
      'authors.allow: required when authors.mode is "listed"; expected at least one GitHub login',
    );
  });

  it('reports every problem at once, one per line', () => {
    const lines = problem('{"version": 2, "limits": {"rateLimit": {"windowMs": 0}}, "nope": 1}').split('\n');

    expect(lines).toHaveLength(3);
    expect(lines.some((line) => line.startsWith('version:'))).toBe(true);
    expect(lines.some((line) => line.startsWith('limits.rateLimit.windowMs:'))).toBe(true);
    expect(lines.some((line) => line.includes('unknown key "nope"'))).toBe(true);
  });
});

describe('the environment variables this replaces', () => {
  it('refuses each one by name and says which key took over', () => {
    for (const [name, key] of Object.entries(LEGACY_ENV)) {
      const message = problem('{}', { [name]: 'anything' });
      expect(message).toBe(`${name} is no longer read; set ${key} in ${FILE}`);
    }
  });

  // An exported-but-empty variable is the same forgotten line in the same shell profile.
  it('refuses one that is set to nothing, and is not rescued by a valid file', () => {
    expect(problem('{"events": {"checks": {"wake": "all"}}}', { PR_CHANNEL_CI_EVENTS: '' })).toContain(
      'PR_CHANNEL_CI_EVENTS is no longer read',
    );
  });

  it('reports all of them together', () => {
    const message = problem('{}', { PR_CHANNEL_SWEEP: 'off', PR_CHANNEL_CACHE_DIR: '/tmp/x' });
    expect(message.split('\n')).toHaveLength(2);
  });
});

// Nothing about the webhook secret is configurable: it is generated per track in memory.
it('never includes a secret in a description', () => {
  const description = JSON.stringify(
    describeConfig(loaded('{"cache": {"dir": "/tmp/markers"}}')),
  );

  expect(description).not.toContain(FAKE_SECRET);
  expect(description).toContain('/tmp/markers');
});

describe('resolveTracking', () => {
  const listed: Config = {
    ...DEFAULT_CONFIG,
    events: {
      ...DEFAULT_CONFIG.events,
      checks: { enabled: true, wake: 'failures' },
      requiredChecks: { enabled: true, names: ['ci/lint'] },
      deployWorkflow: { enabled: true, workflowName: 'Ship It' },
    },
    authors: { mode: 'listed', allow: ['sam-reviewer'], bots: 'ignore' },
  };

  it('takes the argument over the file, and the file over the default', () => {
    const fromArgument = resolveTracking(listed, { ci_events: 'all', required_checks: ['ci/test'] }, 'octo-worker');
    expect(fromArgument.policy.checks.wake).toBe('all');
    expect(fromArgument.requiredChecks).toEqual(['ci/test']);
    expect(fromArgument.origins).toMatchObject({ ciEvents: 'argument', requiredChecks: 'argument' });

    const fromFile = resolveTracking(listed, {}, 'octo-worker');
    expect(fromFile.policy.checks.wake).toBe('failures');
    expect(fromFile.requiredChecks).toEqual(['ci/lint']);
    expect(fromFile.botComments).toBe('ignore');
    expect(fromFile.origins).toMatchObject({ ciEvents: 'config', requiredChecks: 'config', botComments: 'config' });

    const fromDefault = resolveTracking(DEFAULT_CONFIG, {}, 'octo-worker');
    expect(fromDefault.policy.checks.wake).toBe('completed');
    expect(fromDefault.requiredChecks).toEqual([]);
    expect(fromDefault.origins).toMatchObject({ ciEvents: 'default', requiredChecks: 'default', botComments: 'default' });
  });

  it('trusts only the gh login by default, lowercased', () => {
    const settings = resolveTracking(DEFAULT_CONFIG, {}, 'Octo-Worker');

    expect([...(settings.commentAuthors ?? [])]).toEqual(['octo-worker']);
    expect(settings.origins.commentAuthors).toBe('default');
  });

  it('honours each author mode', () => {
    const anyone: Config = { ...DEFAULT_CONFIG, authors: { mode: 'anyone', allow: [], bots: 'handle' } };

    expect(resolveTracking(anyone, {}, 'octo-worker').commentAuthors).toBeNull();
    expect([...(resolveTracking(listed, {}, 'octo-worker').commentAuthors ?? [])]).toEqual(['sam-reviewer']);
    // No gh login and the operator mode leaves nobody to name, so nobody is narrowed out.
    expect(resolveTracking(DEFAULT_CONFIG, {}, null).commentAuthors).toBeNull();
  });

  it('keeps an empty comment_authors argument meaning anyone', () => {
    expect(resolveTracking(listed, { comment_authors: [] }, 'octo-worker').commentAuthors).toBeNull();
    expect([...(resolveTracking(listed, { comment_authors: ['Dana-Eng'] }, 'octo-worker').commentAuthors ?? [])]).toEqual(
      ['dana-eng'],
    );
  });

  it('only names a deploy workflow while one is enabled', () => {
    expect(resolveTracking(listed, {}, null).deployWorkflowName).toBe('Ship It');
    expect(resolveTracking(DEFAULT_CONFIG, {}, null).deployWorkflowName).toBeNull();
    expect(resolveTracking(DEFAULT_CONFIG, {}, null).policy.deployWorkflow.enabled).toBe(false);
  });
});

describe('the arguments one track call may carry', () => {
  // The layer that outranks the file is checked as hard as the file: MCP validates the
  // request envelope and never a tool's own inputSchema, so an unchecked value would
  // reach the filters as something nothing matches and be read as its opposite.
  function refused(raw: unknown): string {
    const result = parseTrackInput(raw);
    if (result.ok) throw new Error('expected the arguments to be refused');
    return result.message;
  }

  function accepted(raw: unknown): TrackInput {
    const result = parseTrackInput(raw);
    if (!result.ok) throw new Error(result.message);
    return result.input;
  }

  it('refuses a value the config file would refuse, in the same words', () => {
    expect(refused({ bot_comments: 'Ignore' })).toBe(
      'bot_comments: "Ignore" is not allowed; expected one of "handle", "ignore"',
    );
    expect(refused({ ci_events: 'Completed' })).toBe(
      'ci_events: "Completed" is not allowed; expected one of "failures", "completed", "all"',
    );
    expect(refused({ ci_events: 'sometimes' })).toContain('is not allowed; expected one of');
  });

  it('names a list that is not a list instead of failing somewhere downstream', () => {
    expect(refused({ required_checks: 'ci/lint' })).toBe('required_checks: "ci/lint" is not valid; expected an array');
    expect(refused({ comment_authors: 'dana-eng' })).toBe('comment_authors: "dana-eng" is not valid; expected an array');
    expect(refused({ comment_authors: ['dana-eng', 7] })).toBe('comment_authors.1: 7 is not valid; expected a string');
    expect(refused({ replace: 'yes' })).toBe('replace: "yes" is not valid; expected a boolean');
    expect(refused({ pr: 42 })).toBe('pr: 42 is not valid; expected a string');
  });

  it('names the call itself when what arrived is not an object of arguments', () => {
    expect(refused('all')).toBe('arguments: "all" is not valid; expected an object');
    expect(refused([])).toBe('arguments: [] is not valid; expected an object');
    // MCP omits arguments entirely for a call that carries none.
    expect(parseTrackInput(null).ok).toBe(true);
  });

  it('names an unknown argument and lists the ones that would have worked', () => {
    expect(refused({ ci_event: 'all' })).toBe(
      'arguments: unknown key "ci_event"; known keys: pr, repo, ci_events, required_checks, comment_authors, ' +
        'bot_comments, replace',
    );
  });

  it('reports every problem at once, one per line', () => {
    const lines = refused({ ci_events: 'Completed', bot_comments: 'Ignore' }).split('\n');

    expect(lines).toHaveLength(2);
    expect(lines.some((line) => line.startsWith('ci_events:'))).toBe(true);
    expect(lines.some((line) => line.startsWith('bot_comments:'))).toBe(true);
  });

  it('passes a well-formed call through, including no arguments at all', () => {
    expect(accepted({ pr: '42', ci_events: 'all', comment_authors: ['dana-eng'], replace: true })).toEqual({
      pr: '42',
      ci_events: 'all',
      comment_authors: ['dana-eng'],
      replace: true,
    });
    expect(accepted({})).toEqual({});
    expect(accepted(undefined)).toEqual({});
  });

  // Without this the bogus value wins the precedence chain and the filters: line reports
  // it as in force, so the operator is told a setting applied that no code matches.
  it('never lets a value the filters cannot match reach resolveTracking', () => {
    expect(parseTrackInput({ bot_comments: 'Ignore' }).ok).toBe(false);

    const settings = resolveTracking(DEFAULT_CONFIG, accepted({ bot_comments: 'ignore' }), 'octo-worker');
    expect(settings.botComments).toBe('ignore');
    expect(settings.origins.botComments).toBe('argument');
  });
});
