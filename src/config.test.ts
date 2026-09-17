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

  // A service manager passes no HOME. Joining an empty one used to yield a relative
  // ".config/..." that resolved against the working directory, so the editor silently
  // edited a different file from the one the plugin reads.
  it('refuses to guess when there is no home to derive it from', () => {
    expect(() => configPath({})).toThrow(/neither HOME nor XDG_CONFIG_HOME/);
    expect(() => configPath({ HOME: '   ' })).toThrow(/neither HOME nor XDG_CONFIG_HOME/);
  });

  it('still resolves when a service sets only one of them', () => {
    expect(configPath({ XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/claude-pr-channel/config.json');
    expect(configPath({ [CONFIG_PATH_ENV]: '/tmp/pr.json' })).toBe('/tmp/pr.json');
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

    expect(config.events.checks).toEqual({ enabled: false, wake: 'failures' });
    expect(config.events.comments).toEqual({ enabled: true });
    expect(config.events.lifecycle).toEqual(DEFAULT_CONFIG.events.lifecycle);
    expect(config.limits).toEqual(DEFAULT_CONFIG.limits);
  });

  it('ignores $schema, which is there for editors', () => {
    expect(loaded('{"$schema": "./schema/config.schema.json"}').events).toEqual(DEFAULT_CONFIG.events);
  });

  it('trims and dedupes author logins', () => {
    const config = loaded('{"authors": {"mode": "listed", "allow": ["Alice", "alice ", "BOB"]}}');

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

  it('refuses a workflow with no name', () => {
    expect(problem('{"events": {"workflows": [{"name": "  "}]}}')).toBe(
      'events.workflows.0.name: "  " is too short; expected at least 1 character',
    );
  });

  it('refuses the same workflow watched twice, which would disagree with itself', () => {
    expect(problem('{"events": {"workflows": [{"name": "Ship It"}, {"name": "Ship It", "wake": "all"}]}}')).toBe(
      'events.workflows.1.name: duplicated: "Ship It" is already watched; expected each workflow named once',
    );
  });

  it('keeps the operator\'s instructions for a workflow, trimmed, and absent when unwritten', () => {
    const withText = loaded('{"events": {"workflows": [{"name": "CI", "instructions": "  Fix the shared setup once.\\nNever retry the run.  "}]}}');
    expect(withText.events.workflows[0]!.instructions).toBe('Fix the shared setup once.\nNever retry the run.');

    const without = loaded('{"events": {"workflows": [{"name": "CI"}]}}');
    expect('instructions' in (without.events.workflows[0] as object)).toBe(false);
  });

  it('refuses a placeholder the renderer has no value for, naming the ones it has', () => {
    expect(problem('{"events": {"workflows": [{"name": "CI", "instructions": "Read {{Workflow}} now"}]}}')).toBe(
      'events.workflows.0.instructions: unknown placeholder "{{Workflow}}"; expected one of ' +
        '{{workflow}}, {{state}}, {{conclusion}}, {{repo}}, {{pr}}, {{head}}, {{run_id}}, {{run_url}}',
    );
    // Every bad entry is named, not just the first.
    expect(
      problem('{"events": {"workflows": [{"name": "CI", "instructions": "{{sha}}"}, {"name": "Build", "instructions": "{{url}}"}]}}').split('\n'),
    ).toHaveLength(2);
    // An unclosed brace is not a template attempt, so it is left alone.
    expect(loaded('{"events": {"workflows": [{"name": "CI", "instructions": "mind the {{gap"}]}}').events.workflows[0]!.instructions).toBe(
      'mind the {{gap',
    );
  });

  it('caps the instructions, so the prompt every event carries stays short', () => {
    expect(problem(JSON.stringify({ events: { workflows: [{ name: 'CI', instructions: 'x'.repeat(1001) }] } }))).toContain(
      'is too long; expected at most 1000 characters',
    );
    expect(loaded(JSON.stringify({ events: { workflows: [{ name: 'CI', instructions: 'x'.repeat(1000) }] } })).events.workflows[0]!.instructions)
      .toHaveLength(1000);
    expect(problem('{"events": {"workflows": [{"name": "CI", "instructions": "   "}]}}')).toBe(
      'events.workflows.0.instructions: "   " is too short; expected at least 1 character',
    );
  });

  it('refuses the listed author mode with nobody listed', () => {
    expect(problem('{"authors": {"mode": "listed"}}')).toBe(
      'authors.allow: required when authors.mode is "listed"; expected at least one GitHub login',
    );
  });

  it('refuses bots "listed" with no bot listed', () => {
    expect(problem('{"authors": {"bots": "listed"}}')).toBe(
      'authors.allowBots: required when authors.bots is "listed"; expected at least one bot login',
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
      workflows: [{ name: 'Ship It', wake: 'success' }],
    },
    authors: { mode: 'listed', allow: ['sam-reviewer'], bots: 'ignore', allowBots: [] },
  };

  it('takes the argument over the file, and the file over the default', () => {
    const fromArgument = resolveTracking(listed, { ci_events: 'all' }, 'octo-worker');
    expect(fromArgument.policy.checks.wake).toBe('all');
    expect(fromArgument.origins).toMatchObject({ ciEvents: 'argument' });

    const fromFile = resolveTracking(listed, {}, 'octo-worker');
    expect(fromFile.policy.checks.wake).toBe('failures');
    expect(fromFile.botComments).toBe('ignore');
    expect(fromFile.origins).toMatchObject({ ciEvents: 'config', botComments: 'config' });

    const fromDefault = resolveTracking(DEFAULT_CONFIG, {}, 'octo-worker');
    expect(fromDefault.policy.checks.wake).toBe('completed');
    expect(fromDefault.origins).toMatchObject({ ciEvents: 'default', botComments: 'default' });
  });

  it('trusts only the gh login by default, lowercased', () => {
    const settings = resolveTracking(DEFAULT_CONFIG, {}, 'Octo-Worker');

    expect([...(settings.commentAuthors ?? [])]).toEqual(['octo-worker']);
    expect(settings.origins.commentAuthors).toBe('default');
  });

  it('honours each author mode', () => {
    const anyone: Config = { ...DEFAULT_CONFIG, authors: { mode: 'anyone', allow: [], bots: 'handle', allowBots: [] } };

    expect(resolveTracking(anyone, {}, 'octo-worker').commentAuthors).toBeNull();
    expect([...(resolveTracking(listed, {}, 'octo-worker').commentAuthors ?? [])]).toEqual(['sam-reviewer']);
    // No gh login and the operator mode leaves nobody to name, so nobody is narrowed out.
    expect(resolveTracking(DEFAULT_CONFIG, {}, null).commentAuthors).toBeNull();
  });

  it('names the bots to hear only when bots are listed', () => {
    const onlyRabbit: Config = {
      ...DEFAULT_CONFIG,
      authors: { mode: 'operator', allow: [], bots: 'listed', allowBots: ['coderabbitai[bot]'] },
    };

    expect([...(resolveTracking(onlyRabbit, {}, 'octo-worker').botAuthors ?? [])]).toEqual(['coderabbitai[bot]']);
    expect(resolveTracking(onlyRabbit, { bot_comments: 'handle' }, 'octo-worker').botAuthors).toBeNull();
    expect(resolveTracking(DEFAULT_CONFIG, {}, 'octo-worker').botAuthors).toBeNull();
    expect(resolveTracking(listed, {}, 'octo-worker').botAuthors).toBeNull();
    expect(resolveTracking(onlyRabbit, {}, 'octo-worker').origins.botComments).toBe('config');
  });

  it('keeps an empty comment_authors argument meaning anyone', () => {
    expect(resolveTracking(listed, { comment_authors: [] }, 'octo-worker').commentAuthors).toBeNull();
    expect([...(resolveTracking(listed, { comment_authors: ['Dana-Eng'] }, 'octo-worker').commentAuthors ?? [])]).toEqual(
      ['dana-eng'],
    );
  });

  it('watches only the workflows that are named, and none by default', () => {
    expect([...resolveTracking(listed, {}, null).workflowNames]).toEqual(['Ship It']);
    expect(resolveTracking(listed, {}, null).policy.workflows.get('Ship It')).toBe('success');
    expect([...resolveTracking(DEFAULT_CONFIG, {}, null).workflowNames]).toEqual([]);
    expect(resolveTracking(DEFAULT_CONFIG, {}, null).policy.workflows.size).toBe(0);
  });

  it('carries the instructions only for the workflows that wrote them, branded as the operator\'s', () => {
    const some: Config = {
      ...DEFAULT_CONFIG,
      events: {
        ...DEFAULT_CONFIG.events,
        workflows: [
          { name: 'Build Image', wake: 'success', instructions: 'Pull the image for {{head}}' },
          { name: 'Nightly Bench', wake: 'failures' },
        ],
      },
    };
    const settings = resolveTracking(some, {}, null);

    expect(settings.workflowInstructions.get('Build Image')).toEqual({ operator: true, text: 'Pull the image for {{head}}' });
    expect(settings.workflowInstructions.has('Nightly Bench')).toBe(false);
    expect(resolveTracking(DEFAULT_CONFIG, {}, null).workflowInstructions.size).toBe(0);
    // The wake map is untouched by any of this: it decides waking, not wording.
    expect(settings.policy.workflows.get('Build Image')).toBe('success');
  });

  it('keeps the wake value each workflow was given', () => {
    const many = {
      ...DEFAULT_CONFIG,
      events: {
        ...DEFAULT_CONFIG.events,
        workflows: [
          { name: 'Build Image', wake: 'success' },
          { name: 'Nightly Bench', wake: 'failures' },
        ],
      },
    } as typeof DEFAULT_CONFIG;
    const policy = resolveTracking(many, {}, null).policy;
    expect(policy.workflows.get('Build Image')).toBe('success');
    expect(policy.workflows.get('Nightly Bench')).toBe('failures');
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
      'arguments: unknown key "ci_event"; known keys: pr, repo, ci_events, comment_authors, ' +
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
