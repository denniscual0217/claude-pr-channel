import { describe, expect, it } from 'bun:test';
import type { PrEvent, PrRef } from '../types.js';
import { normalizeWebhook } from './normalize.js';
import { RequiredChecksTracker } from './required-checks.js';

const repository = { full_name: 'Acme-Labs/Example' };
const sender = { login: 'octocat' };
const pr: PrRef = { repo: 'acme-labs/example', prNumber: 42 };
const head = 'a'.repeat(40);
const olderHead = 'b'.repeat(40);

function checkRun(name: string, conclusion: string, headSha: string, completedAt: string): Record<string, unknown> {
  return {
    action: conclusion === 'rerequested' ? 'rerequested' : 'completed',
    repository,
    sender,
    check_run: {
      id: 9001,
      name,
      head_sha: headSha,
      status: 'completed',
      conclusion: conclusion === 'rerequested' ? 'success' : conclusion,
      completed_at: completedAt,
      pull_requests: [{ number: 42 }],
    },
  };
}

function ciEvent(checkName: string, conclusion: string, headSha = head, completedAt = '2026-09-07T10:05:00Z'): PrEvent {
  return normalizeWebhook('check_run', checkRun(checkName, conclusion, headSha, completedAt))!;
}

function synchronize(headSha: string): PrEvent {
  return normalizeWebhook('pull_request', {
    action: 'synchronize',
    repository,
    sender,
    pull_request: {
      number: 42,
      title: 'Add the thing',
      draft: false,
      updated_at: '2026-09-07T10:00:00Z',
      head: { sha: headSha, ref: 'feature/thing' },
      base: { ref: 'main' },
    },
  })!;
}

describe('RequiredChecksTracker', () => {
  it('announces all-required-green exactly once when every required check succeeds', () => {
    const tracker = new RequiredChecksTracker(['lint', 'test']);
    expect(tracker.observe(ciEvent('lint', 'success'), head)).toBeNull();
    expect(tracker.observe(ciEvent('docs', 'success'), head)).toBeNull();
    const green = tracker.observe(ciEvent('test', 'success'), head);
    expect(green).toMatchObject({
      kind: 'ci_all_required_green',
      prRef: pr,
      headSha: head,
      checkNames: ['lint', 'test'],
    });
    expect(tracker.observe(ciEvent('test', 'success'), head)).toBeNull();
  });

  it('is not green while any required check is missing, failed or re-queued', () => {
    const tracker = new RequiredChecksTracker(['lint', 'test']);
    expect(tracker.observe(ciEvent('lint', 'success'), head)).toBeNull();
    expect(tracker.observe(ciEvent('test', 'failure'), head)).toBeNull();
    expect(tracker.observe(ciEvent('test', 'success'), head)).not.toBeNull();
    expect(tracker.observe(ciEvent('test', 'rerequested'), head)).toBeNull();
    expect(tracker.observe(ciEvent('test', 'success'), head)).not.toBeNull();
  });

  it('tracks each head separately so an old head cannot make a new head green', () => {
    const tracker = new RequiredChecksTracker(['lint', 'test']);
    expect(tracker.observe(ciEvent('lint', 'success', olderHead), head)).toBeNull();
    expect(tracker.observe(ciEvent('lint', 'success', head), head)).toBeNull();
    expect(tracker.observe(ciEvent('test', 'success', olderHead), head)).toMatchObject({ headSha: olderHead });
    expect(tracker.states(head).size).toBe(1);
    expect(tracker.observe(ciEvent('test', 'success', head), head)).toMatchObject({ headSha: head });
  });

  it('never announces without a configured required list', () => {
    const tracker = new RequiredChecksTracker([]);
    expect(tracker.observe(ciEvent('lint', 'success'), head)).toBeNull();
  });

  it('forgets every head of a PR once it closes', () => {
    const tracker = new RequiredChecksTracker(['lint']);
    tracker.observe(ciEvent('lint', 'failure', olderHead), olderHead);
    tracker.observe(ciEvent('lint', 'success', head), head);
    tracker.forget();
    expect(tracker.states(head).size).toBe(0);
    expect(tracker.states(olderHead).size).toBe(0);
  });

  it("keeps the current head's checks when a lifecycle event for another head is refused", () => {
    const tracker = new RequiredChecksTracker(['lint', 'test']);
    tracker.observe(ciEvent('lint', 'success', head), head);

    // The registry refused this out-of-order synchronize, so the head is still `head`.
    expect(tracker.observe(synchronize(olderHead), head)).toBeNull();

    expect(tracker.states(head).size).toBe(1);
    expect(tracker.observe(ciEvent('test', 'success', head), head)).toMatchObject({ headSha: head });
  });

  it('keeps checks banked for a head the registry has not reached yet', () => {
    const tracker = new RequiredChecksTracker(['lint', 'test']);
    tracker.observe(ciEvent('lint', 'success', head), olderHead);

    // A lifecycle delivery carrying the head still in force says nothing about `head`.
    expect(tracker.observe(synchronize(olderHead), olderHead)).toBeNull();

    expect(tracker.states(head).size).toBe(1);
    expect(tracker.observe(ciEvent('test', 'success', head), head)).toMatchObject({ headSha: head });
  });

  it('drops nothing while the route has no head at all', () => {
    const tracker = new RequiredChecksTracker(['lint', 'test']);
    tracker.observe(ciEvent('lint', 'success', head), null);
    expect(tracker.observe(synchronize(head), null)).toBeNull();
    expect(tracker.observe(ciEvent('test', 'success', head), null)).toMatchObject({ headSha: head });
  });


  it('announces a head that was already green once it becomes the current head', () => {
    const tracker = new RequiredChecksTracker(['lint', 'test']);
    tracker.observe(ciEvent('lint', 'success', head), olderHead);
    // Green for a head that is not current: history, not a green light, so it does not
    // spend the one announcement that head is owed.
    expect(tracker.observe(ciEvent('test', 'success', head), olderHead)).toMatchObject({ headSha: head });

    expect(tracker.observe(synchronize(head), head)).toMatchObject({
      kind: 'ci_all_required_green',
      headSha: head,
    });
    expect(tracker.observe(synchronize(head), head)).toBeNull();
    expect(tracker.observe(ciEvent('test', 'success', head), head)).toBeNull();
  });

  it('re-announces a head whose green was suppressed, once that head becomes current', () => {
    const tracker = new RequiredChecksTracker(['lint', 'test']);
    tracker.observe(ciEvent('lint', 'success', head), null);
    // No head on record, so this green reaches the session as history only.
    expect(tracker.observe(ciEvent('test', 'success', head), null)).toMatchObject({ headSha: head });

    expect(tracker.observe(synchronize(head), head)).toMatchObject({
      kind: 'ci_all_required_green',
      headSha: head,
    });
    expect(tracker.observe(synchronize(head), head)).toBeNull();
  });



  it('keeps a newer failure when an older success is redelivered', () => {
    const tracker = new RequiredChecksTracker(['lint', 'test']);
    tracker.observe(ciEvent('lint', 'success'), head);
    expect(tracker.observe(ciEvent('test', 'success'), head)).not.toBeNull();
    expect(tracker.observe(ciEvent('test', 'failure', head, '2026-09-07T10:10:00Z'), head)).toBeNull();

    // GitHub redelivers the earlier success: newest on the wire, oldest in fact.
    expect(tracker.observe(ciEvent('test', 'success', head, '2026-09-07T10:05:00Z'), head)).toBeNull();
    expect(tracker.states(head).get('test')).toEqual({ status: 'completed', conclusion: 'failure' });
  });

  it('bounds the heads it keeps per PR, oldest first', () => {
    const tracker = new RequiredChecksTracker(['lint'], { maxTrackedHeads: 2 });
    const heads = ['1', '2', '3'].map((digit) => digit.repeat(40));
    for (const headSha of heads) tracker.observe(ciEvent('lint', 'failure', headSha), headSha);

    // The prune walks check_heads and takes the states of whatever it drops with it.
    expect(tracker.states(heads[0]!).size).toBe(0);
    expect(tracker.states(heads[1]!).size).toBe(1);
    expect(tracker.states(heads[2]!).size).toBe(1);
  });
});
