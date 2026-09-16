import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { ConfigSchema, TRACK_INPUT_KEYS, TrackInputSchema, configJsonSchema, trackInputJsonSchema } from './config-schema.js';
import { DEFAULT_CONFIG } from './config.js';
import { PR_LIFECYCLE_ACTIONS } from './types.js';

const COMMITTED = join(import.meta.dir, '..', 'schema', 'config.schema.json');

type Node = Record<string, unknown>;

const generated = configJsonSchema();

function objectNodes(node: Node, path = ''): [string, Node][] {
  const properties = node['properties'] as Record<string, Node> | undefined;
  if (properties === undefined) return [];
  const here: [string, Node][] = [[path === '' ? '(root)' : path, node]];
  for (const [key, child] of Object.entries(properties)) {
    here.push(...objectNodes(child, path === '' ? key : `${path}.${key}`));
  }
  return here;
}

function leaves(node: Node, path = ''): [string, Node][] {
  const properties = node['properties'] as Record<string, Node> | undefined;
  if (properties === undefined) return [[path, node]];
  return Object.entries(properties).flatMap(([key, child]) => leaves(child, path === '' ? key : `${path}.${key}`));
}

describe('the committed JSON Schema', () => {
  // Editing the zod tree without running `bun run schema` fails here rather than shipping
  // a UI a schema that no longer matches what the plugin accepts.
  it('is exactly what the zod schema generates', () => {
    expect(readFileSync(COMMITTED, 'utf8')).toBe(`${JSON.stringify(generated, null, 2)}\n`);
  });

  it('describes every option, so a form can be built from it without reading the code', () => {
    const undescribed = leaves(generated)
      .filter(([, leaf]) => String(leaf['description'] ?? '').trim() === '')
      .map(([path]) => path);

    expect(undescribed).toEqual([]);
  });

  it('rejects unknown keys at every level, exactly as the loader does', () => {
    for (const [path, node] of objectNodes(generated)) {
      expect([path, node['additionalProperties']]).toEqual([path, false]);
    }
  });

  it('lists every lifecycle action the code knows and no others', () => {
    const lifecycle = generated['properties'] as Record<string, Node>;
    const events = lifecycle['events']?.['properties'] as Record<string, Node>;
    const actions = Object.keys(events['lifecycle']?.['properties'] as Record<string, Node>);

    expect(actions).toEqual([...PR_LIFECYCLE_ACTIONS]);
  });

  it('leaves every defaulted field optional, so a UI may write a partial file', () => {
    expect(generated['required']).toBeUndefined();
    expect(generated['$id']).toBe('config.schema.json');
    expect(String(generated['description'])).toContain('claude-pr-channel/config.json');
  });

  it('carries the same choices and bounds the validator enforces', () => {
    const at = (path: string): Node =>
      path.split('.').reduce<Node>((node, key) => (node['properties'] as Record<string, Node>)[key] as Node, generated);

    expect(at('events.checks.wake')['enum']).toEqual(['failures', 'completed', 'all']);
    expect(ConfigSchema.safeParse({ events: { checks: { wake: 'sometimes' } } }).success).toBe(false);

    expect(at('authors.mode')['enum']).toEqual(['operator', 'listed', 'anyone']);
    expect(at('authors.bots')['enum']).toEqual(['handle', 'listed', 'ignore']);
    expect(at('authors.allowBots')).toMatchObject({ type: 'array' });
    expect(ConfigSchema.safeParse({ authors: { bots: 'listed' } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ authors: { bots: 'listed', allowBots: ['coderabbitai[bot]'] } }).success).toBe(true);
    expect(at('limits.maxPayloadBytes')).toMatchObject({ type: 'integer', minimum: 1, maximum: 26_214_400 });
    expect(ConfigSchema.safeParse({ limits: { maxPayloadBytes: 26_214_401 } }).success).toBe(false);
    expect(at('cache.dir')['type']).toEqual(['string', 'null']);
  });
});

describe('the schema the track tool advertises', () => {
  const advertised = trackInputJsonSchema();
  const at = (key: string): Node => (advertised['properties'] as Record<string, Node>)[key] as Node;

  // What the model is shown and what the plugin holds it to are one definition: a client
  // that ignores the advertised enum still cannot get a value past the parser.
  it('offers exactly the choices the file and the parser accept', () => {
    const inFile = (path: string): Node =>
      path.split('.').reduce<Node>((node, key) => (node['properties'] as Record<string, Node>)[key] as Node, generated);

    expect(at('ci_events')['enum']).toEqual(inFile('events.checks.wake')['enum']);
    expect(at('ci_events')['enum']).toEqual(['failures', 'completed', 'all']);
    // bot_comments is the one argument narrower than its file key: "listed" needs the
    // logins that go with it, and a track call has nowhere to put them, so offering it
    // here could only ever mean an empty list — which silently drops every bot.
    expect(inFile('authors.bots')['enum']).toEqual(['handle', 'listed', 'ignore']);
    expect(at('bot_comments')['enum']).toEqual(['handle', 'ignore']);
    expect(TrackInputSchema.safeParse({ bot_comments: 'listed' }).success).toBe(false);
    expect(TrackInputSchema.safeParse({ ci_events: 'Completed' }).success).toBe(false);
    expect(TrackInputSchema.safeParse({ bot_comments: 'Ignore' }).success).toBe(false);
    expect(TrackInputSchema.safeParse({ ci_events: 'all', bot_comments: 'ignore' }).success).toBe(true);
  });

  it('takes no argument it does not name, and describes every one it does', () => {
    expect(advertised['additionalProperties']).toBe(false);
    expect(Object.keys(advertised['properties'] as Node)).toEqual([...TRACK_INPUT_KEYS]);
    expect(advertised['required']).toBeUndefined();

    const undescribed = TRACK_INPUT_KEYS.filter((key) => String(at(key)['description'] ?? '').trim() === '');
    expect(undescribed).toEqual([]);
  });

  it('overrides the file settings with the same names the file uses', () => {
    expect(String(at('ci_events')['description'])).toContain('events.checks.wake');
    expect(String(at('bot_comments')['description'])).toContain('authors.bots');
  });
});

describe('the defaults', () => {
  it('are what an empty file parses to, and what the README documents', () => {
    expect(DEFAULT_CONFIG).toEqual(ConfigSchema.parse({}));
  });
});
