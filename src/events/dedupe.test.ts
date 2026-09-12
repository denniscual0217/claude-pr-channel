import { describe, expect, it } from 'bun:test';
import type { PrEvent, PrRef } from '../types.js';
import { untrusted } from '../types.js';
import { DeliveryDeduper, logicalFingerprint } from './dedupe.js';

const pr: PrRef = { repo: 'acme-labs/example', prNumber: 42 };

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

describe('delivery id dedup', () => {
  it('accepts a delivery once and reports replays', () => {
    const deduper = new DeliveryDeduper();
    const input = { deliveryId: 'gh-1', eventName: 'pull_request', repo: pr.repo };
    expect(deduper.accept(input)).toEqual({ accepted: true, deliveryId: 'gh-1' });
    expect(deduper.accept(input)).toEqual({ accepted: false, reason: 'replayed_delivery', deliveryId: 'gh-1' });
    expect(deduper.accept({ ...input, deliveryId: ' gh-1 ' })).toMatchObject({ reason: 'replayed_delivery' });
    expect(deduper.accept({ ...input, deliveryId: 'gh-2' })).toMatchObject({ accepted: true });
  });

  it('rejects a delivery it cannot identify', () => {
    const deduper = new DeliveryDeduper();
    expect(deduper.accept({ deliveryId: undefined, eventName: 'pull_request', repo: null })).toEqual({
      accepted: false,
      reason: 'missing_delivery_id',
    });
    expect(deduper.accept({ deliveryId: '   ', eventName: 'pull_request', repo: null })).toEqual({
      accepted: false,
      reason: 'missing_delivery_id',
    });
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
    const deduper = new DeliveryDeduper();
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
    const deduper = new DeliveryDeduper({ logicalWindow: 2 });
    deduper.noteLogicalState(comment({ commentId: 1 }), 'd1');
    deduper.noteLogicalState(comment({ commentId: 2 }), 'd2');
    deduper.noteLogicalState(comment({ commentId: 3 }), 'd3');
    expect(deduper.noteLogicalState(comment({ commentId: 1 }), 'd4')).toBeNull();
    expect(deduper.noteLogicalState(comment({ commentId: 3 }), 'd5')).toMatchObject({ previousDeliveryId: 'd3' });
  });
});

describe('the delivery id window', () => {
  it('bounds what it remembers, oldest id first', () => {
    const deduper = new DeliveryDeduper({ deliveryWindow: 2 });
    const accept = (deliveryId: string) =>
      deduper.accept({ deliveryId, eventName: 'check_run', repo: pr.repo });
    expect(accept('d1')).toMatchObject({ accepted: true });
    expect(accept('d2')).toMatchObject({ accepted: true });
    expect(accept('d1')).toMatchObject({ reason: 'replayed_delivery' });
    expect(accept('d3')).toMatchObject({ accepted: true });
    // d1 fell out of the window; a replay of it is no longer recognised, which is the
    // price of having no database and is why the window is large by default.
    expect(accept('d1')).toMatchObject({ accepted: true });
    expect(accept('d3')).toMatchObject({ reason: 'replayed_delivery' });
  });
});
