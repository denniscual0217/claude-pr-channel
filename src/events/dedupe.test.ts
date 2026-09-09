import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelDb } from '../store/db.js';
import type { PrEvent, PrRef } from '../types.js';
import { untrusted } from '../types.js';
import { DeliveryDeduper, logicalFingerprint } from './dedupe.js';

const execFileAsync = promisify(execFile);
const pr: PrRef = { repo: 'toptal/example', prNumber: 42 };

function comment(overrides: Partial<{ commentId: number; body: string; action: 'created' | 'edited' }> = {}): PrEvent {
  return {
    kind: 'pr_comment',
    prRef: pr,
    headSha: null,
    actorLogin: 'someone',
    occurredAtIso: '2026-09-07T10:00:00.000Z',
    htmlUrl: null,
    action: overrides.action ?? 'created',
    commentId: overrides.commentId ?? 7,
    untrustedBody: untrusted(overrides.body ?? 'hello'),
  };
}

function check(overrides: Partial<{ headSha: string; conclusion: 'success' | 'failure'; checkName: string }> = {}): PrEvent {
  return {
    kind: 'ci_check',
    prRef: pr,
    headSha: overrides.headSha ?? 'abc',
    actorLogin: null,
    occurredAtIso: '2026-09-07T10:00:00.000Z',
    htmlUrl: null,
    checkName: overrides.checkName ?? 'lint',
    checkRunId: 1,
    state: { status: 'completed', conclusion: overrides.conclusion ?? 'success' },
    detailsUrl: null,
  };
}

let dir: string;
let dbPath: string;
let db: ChannelDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pr-channel-dedupe-'));
  dbPath = join(dir, 'channel.db');
  db = ChannelDb.open(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('delivery id dedup', () => {
  it('accepts a delivery once and reports replays', () => {
    const deduper = new DeliveryDeduper(db);
    const input = { deliveryId: 'gh-1', eventName: 'pull_request', repo: pr.repo };
    expect(deduper.accept(input)).toEqual({ accepted: true, deliveryId: 'gh-1' });
    expect(deduper.accept(input)).toEqual({ accepted: false, reason: 'replayed_delivery', deliveryId: 'gh-1' });
    expect(deduper.accept({ ...input, deliveryId: ' gh-1 ' })).toMatchObject({ reason: 'replayed_delivery' });
    expect(deduper.accept({ ...input, deliveryId: 'gh-2' })).toMatchObject({ accepted: true });
  });

  it('rejects a delivery it cannot identify', () => {
    const deduper = new DeliveryDeduper(db);
    expect(deduper.accept({ deliveryId: undefined, eventName: 'pull_request', repo: null })).toEqual({
      accepted: false,
      reason: 'missing_delivery_id',
    });
    expect(deduper.accept({ deliveryId: '   ', eventName: 'pull_request', repo: null })).toEqual({
      accepted: false,
      reason: 'missing_delivery_id',
    });
    expect(db.hasDelivery('')).toBe(false);
  });

  it('is durable across connections', () => {
    new DeliveryDeduper(db).accept({ deliveryId: 'gh-durable', eventName: 'issue_comment', repo: pr.repo });
    const other = ChannelDb.open(dbPath);
    try {
      expect(new DeliveryDeduper(other).accept({ deliveryId: 'gh-durable', eventName: 'issue_comment', repo: pr.repo }))
        .toMatchObject({ reason: 'replayed_delivery' });
    } finally {
      other.close();
    }
  });

  it('accepts exactly one of two concurrent identical deliveries across processes', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `race-${i}`);
    const results = await Promise.all([runRacer(dir, dbPath, ids, 'A'), runRacer(dir, dbPath, ids, 'B')]);
    const accepted = new Map<string, string[]>();
    for (const [label, wins] of results) {
      for (const id of wins) accepted.set(id, [...(accepted.get(id) ?? []), label]);
    }
    expect([...accepted.keys()].sort()).toEqual([...ids].sort());
    for (const id of ids) expect(accepted.get(id)).toHaveLength(1);
    expect(db.hasDelivery('race-0')).toBe(true);
  });
});

describe('logical duplicates', () => {
  it('fingerprints the same state identically and different state differently', () => {
    expect(logicalFingerprint(comment())).toBe(logicalFingerprint(comment()));
    expect(logicalFingerprint(comment())).not.toBe(logicalFingerprint(comment({ body: 'other' })));
    expect(logicalFingerprint(comment())).not.toBe(logicalFingerprint(comment({ action: 'edited' })));
    expect(logicalFingerprint(check())).not.toBe(logicalFingerprint(check({ conclusion: 'failure' })));
    expect(logicalFingerprint(check())).not.toBe(logicalFingerprint(check({ headSha: 'def' })));
    expect(logicalFingerprint(check())).not.toBe(logicalFingerprint(check({ checkName: 'test' })));
  });

  it('reports, but does not drop, the same state under a fresh delivery id', () => {
    const deduper = new DeliveryDeduper(db);
    expect(deduper.accept({ deliveryId: 'gh-1', eventName: 'check_run', repo: pr.repo })).toMatchObject({ accepted: true });
    expect(deduper.noteLogicalState(check(), 'gh-1')).toBeNull();
    expect(deduper.accept({ deliveryId: 'gh-2', eventName: 'check_run', repo: pr.repo })).toMatchObject({ accepted: true });
    expect(deduper.noteLogicalState(check(), 'gh-2')).toEqual({
      fingerprint: logicalFingerprint(check()),
      previousDeliveryId: 'gh-1',
    });
    expect(deduper.noteLogicalState(check(), 'gh-1')).toBeNull();
    expect(deduper.noteLogicalState(check({ conclusion: 'failure' }), 'gh-3')).toBeNull();
  });

  it('forgets fingerprints beyond its window', () => {
    const deduper = new DeliveryDeduper(db, { logicalWindow: 2 });
    deduper.noteLogicalState(comment({ commentId: 1 }), 'd1');
    deduper.noteLogicalState(comment({ commentId: 2 }), 'd2');
    deduper.noteLogicalState(comment({ commentId: 3 }), 'd3');
    expect(deduper.noteLogicalState(comment({ commentId: 1 }), 'd4')).toBeNull();
    expect(deduper.noteLogicalState(comment({ commentId: 3 }), 'd5')).toMatchObject({ previousDeliveryId: 'd3' });
  });
});

// Runs the real DeliveryDeduper in a child process under Node's native type stripping.
// Relative imports in src use .js specifiers, so a tiny resolve hook retries them as .ts.
// Startup under the hook is slow and uneven, so the children gate on each other's
// ready file instead of a wall-clock start. How the wins split between them is up to
// the scheduler and SQLite's busy back-off, so only exactly-once is asserted.
async function runRacer(scratch: string, path: string, ids: readonly string[], label: string): Promise<[string, string[]]> {
  const hooksPath = join(scratch, 'hooks.mjs');
  const registerPath = join(scratch, 'register.mjs');
  const scriptPath = join(scratch, `racer-${label}.mjs`);
  writeFileSync(
    hooksPath,
    `export async function resolve(specifier, context, next) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        try { return await next(specifier, context); }
        catch (error) {
          if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
          return next(specifier.slice(0, -3) + '.ts', context);
        }
      }
      return next(specifier, context);
    }`,
  );
  writeFileSync(
    registerPath,
    `import { register } from 'node:module';
     register(${JSON.stringify(pathToFileURL(hooksPath).href)}, import.meta.url);`,
  );
  const dbModule = pathToFileURL(resolve(process.cwd(), 'src/store/db.ts')).href;
  const dedupeModule = pathToFileURL(resolve(process.cwd(), 'src/events/dedupe.ts')).href;
  writeFileSync(
    scriptPath,
    `import { existsSync, writeFileSync } from 'node:fs';
     import { ChannelDb } from ${JSON.stringify(dbModule)};
     import { DeliveryDeduper } from ${JSON.stringify(dedupeModule)};
     const db = ChannelDb.open(${JSON.stringify(path)});
     const deduper = new DeliveryDeduper(db);
     writeFileSync(${JSON.stringify(join(scratch, `ready-${label}`))}, '');
     const gate = new Int32Array(new SharedArrayBuffer(4));
     const peers = ${JSON.stringify(['A', 'B'].map((peer) => join(scratch, `ready-${peer}`)))};
     while (!peers.every((file) => existsSync(file))) Atomics.wait(gate, 0, 0, 1);
     const wins = [];
     for (const id of ${JSON.stringify(ids)}) {
       if (deduper.accept({ deliveryId: id, eventName: 'check_run', repo: 'toptal/example' }).accepted) wins.push(id);
     }
     db.close();
     process.stdout.write(JSON.stringify(wins));`,
  );
  const { stdout } = await execFileAsync(process.execPath, ['--no-warnings', '--import', registerPath, scriptPath], {
    cwd: scratch,
  });
  return [label, JSON.parse(stdout) as string[]];
}
