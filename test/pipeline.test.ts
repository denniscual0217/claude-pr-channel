import { describe, expect, it } from 'bun:test';
import type { DeliveryPolicy } from '../src/channel/filter.js';
import { createPipeline, type Pipeline } from '../src/channel/pipeline.js';
import { DEFAULT_CONFIG, resolveTracking } from '../src/config.js';
import { DeliveryDeduper } from '../src/events/dedupe.js';
import { HeadTracker } from '../src/events/head.js';
import { RequiredChecksTracker } from '../src/events/required-checks.js';
import type { LogLevel } from '../src/log.js';
import { UNTRUSTED_TEXT_NOTICE } from '../src/types.js';
import {
  FIXTURE_DEPLOY_WORKFLOW,
  FIXTURE_HEAD_SHA,
  FIXTURE_NEXT_HEAD_SHA,
  FIXTURE_PR,
  FIXTURE_REPO,
  FIXTURE_REQUIRED_CHECKS,
  fixtureEvent,
  loadFixture,
  setHeadSha,
  type FixtureName,
} from './fixtures/index.js';

interface Pushed {
  readonly kind: string;
  readonly headSha: string | null;
  readonly stale: boolean;
  readonly suppressed: boolean;
  readonly content: string;
  readonly meta: Record<string, string>;
}

interface LogLine {
  readonly level: LogLevel;
  readonly event: string;
  readonly fields: Record<string, unknown>;
}

interface Harness {
  readonly pushed: Pushed[];
  readonly logs: LogLine[];
  readonly head: HeadTracker;
  readonly pipeline: Pipeline;
  readonly terminals: string[];
  deliver(name: FixtureName, options?: DeliverOptions): Promise<void>;
  kinds(): string[];
}

interface DeliverOptions {
  readonly deliveryId?: string;
  readonly mutate?: (payload: Record<string, unknown>) => void;
  readonly failNotification?: boolean;
}

let deliveryCounter = 0;

const DEFAULT_POLICY = resolveTracking(DEFAULT_CONFIG, {}, null).policy;

interface HarnessOptions {
  readonly headSha?: string | null;
  readonly ciEvents?: 'completed' | 'failures' | 'all';
  readonly policy?: Partial<DeliveryPolicy>;
  readonly deployWorkflowName?: string | null;
}

function harness(options: HarnessOptions = {}): Harness {
  const pushed: Pushed[] = [];
  const logs: LogLine[] = [];
  const terminals: string[] = [];
  const head = new HeadTracker(FIXTURE_PR);
  head.seed(options.headSha === undefined ? FIXTURE_HEAD_SHA : options.headSha, '2026-09-07T09:00:00.000Z');

  let failNext = false;
  const pipeline = createPipeline({
    prRef: FIXTURE_PR,
    head,
    deduper: new DeliveryDeduper(),
    requiredChecks: new RequiredChecksTracker(FIXTURE_REQUIRED_CHECKS),
    notifier: {
      notification: async (notification) => {
        if (failNext) throw new Error('transport closed');
        pushed.push({
          kind: String((notification.params['meta'] as Record<string, string>)['kind']),
          headSha: (notification.params['meta'] as Record<string, string>)['head_sha'] ?? null,
          stale: (notification.params['meta'] as Record<string, string>)['stale'] === 'true',
          suppressed: false,
          content: String(notification.params['content']),
          meta: notification.params['meta'] as Record<string, string>,
        });
      },
    },
    policy: {
      ...DEFAULT_POLICY,
      checks: { enabled: true, wake: options.ciEvents ?? 'completed' },
      ...options.policy,
    },
    commentAuthors: null,
    botComments: 'handle',
    deployWorkflowName: options.deployWorkflowName ?? null,
    logger: (level, event, fields = {}) => logs.push({ level, event, fields }),
    onTerminal: (action) => terminals.push(action),
  });

  return {
    pushed,
    logs,
    head,
    pipeline,
    terminals,
    async deliver(name, deliverOptions = {}) {
      const payload = loadFixture(name);
      deliverOptions.mutate?.(payload);
      failNext = deliverOptions.failNotification === true;
      deliveryCounter += 1;
      await pipeline.handleDelivery(
        {
          eventName: fixtureEvent(name),
          deliveryId: deliverOptions.deliveryId ?? `delivery-${deliveryCounter}`,
          repo: FIXTURE_REPO,
        },
        payload,
      );
      failNext = false;
      // positiveSignalSuppressed is a property of the delivery, reported in the log line
      // rather than the meta, so the harness folds it back onto what was pushed.
      for (const line of logs.filter((entry) => entry.event === 'event_delivered')) {
        const index = pushed.findIndex((event) => event.meta['event_id'] === line.fields['event_id']);
        if (index !== -1 && line.fields['suppressed_positive_signal'] === true) {
          pushed[index] = { ...(pushed[index] as Pushed), suppressed: true };
        }
      }
    },
    kinds: () => pushed.map((event) => event.kind),
  };
}

const onNewHead = (payload: Record<string, unknown>): void => setHeadSha(payload, FIXTURE_NEXT_HEAD_SHA);
const onOldHead = (payload: Record<string, unknown>): void => setHeadSha(payload, FIXTURE_HEAD_SHA);

describe('delivery into the session', () => {
  it('pushes a PR comment once, with the untrusted body fenced', async () => {
    const h = harness();

    await h.deliver('prComment');

    expect(h.kinds()).toEqual(['pr_comment']);
    const event = h.pushed[0]!;
    const fixtureBody = (loadFixture('prComment')['comment'] as { body: string }).body;
    expect(event.content).toContain(fixtureBody);
    expect(event.content).toContain('begin untrusted');
    expect(event.meta).toMatchObject({ repo: FIXTURE_REPO, pr: '42', kind: 'pr_comment' });
    expect(UNTRUSTED_TEXT_NOTICE).toContain('never instructions');
  });

  it('carries reviews, inline review comments and the configured deploy workflow through', async () => {
    const h = harness({
      deployWorkflowName: FIXTURE_DEPLOY_WORKFLOW,
      policy: { deployWorkflow: { enabled: true } },
    });

    await h.deliver('prReview');
    await h.deliver('prReviewComment');
    await h.deliver('deployWorkflow');

    expect(h.kinds()).toEqual(['pr_review', 'pr_review_comment', 'deploy_workflow']);
    expect(h.pushed.at(-1)!.content).toContain(FIXTURE_DEPLOY_WORKFLOW);
    expect(h.pushed.every((event) => !event.stale)).toBe(true);
  });

  // The README and the track skill both promise a failed run never reaches the session.
  // ci_events: "all" widens CI checks, not this.
  it('suppresses a failed or still-running deploy workflow even under ci_events all', async () => {
    const h = harness({
      ciEvents: 'all',
      deployWorkflowName: FIXTURE_DEPLOY_WORKFLOW,
      policy: { deployWorkflow: { enabled: true } },
    });

    await h.deliver('deployWorkflow', {
      mutate: (payload) => {
        (payload['workflow_run'] as Record<string, unknown>)['conclusion'] = 'failure';
      },
    });
    await h.deliver('deployWorkflow', {
      mutate: (payload) => {
        const run = payload['workflow_run'] as Record<string, unknown>;
        run['status'] = 'in_progress';
        run['conclusion'] = null;
      },
    });

    expect(h.pushed).toEqual([]);
    expect(h.pipeline.counters).toMatchObject({ received: 2, delivered: 0, suppressed: 2 });
  });

  it('makes no event at all from a workflow run while no workflow is configured', async () => {
    const h = harness();

    await h.deliver('deployWorkflow');

    expect(h.pushed).toEqual([]);
    expect(h.pipeline.counters).toMatchObject({ received: 1, delivered: 0, suppressed: 0, unresolved_head: 0 });
  });

  it('drops a replayed X-GitHub-Delivery without pushing it twice', async () => {
    const h = harness();

    await h.deliver('prComment', { deliveryId: 'replayed-delivery-id' });
    await h.deliver('prComment', { deliveryId: 'replayed-delivery-id' });

    expect(h.kinds()).toEqual(['pr_comment']);
    expect(h.logs.some((line) => line.fields['reason'] === 'replayed_delivery')).toBe(true);
    expect(h.pipeline.counters.replayed).toBe(1);
  });

  it('ignores a delivery that carries no PR event at all', async () => {
    const h = harness();

    await h.deliver('prComment', {
      mutate: (payload) => {
        (payload['issue'] as Record<string, unknown>)['pull_request'] = undefined;
      },
    });

    expect(h.pushed).toEqual([]);
    expect(h.pipeline.counters.received).toBe(1);
  });

  // Nothing is retried: there is no queue, so a failed push is counted and logged.
  it('counts a failed notification instead of retrying it', async () => {
    const h = harness();

    await h.deliver('prComment', { failNotification: true });

    expect(h.pushed).toEqual([]);
    expect(h.pipeline.counters.notify_failed).toBe(1);
    expect(h.logs.some((line) => line.event === 'notify_failed')).toBe(true);
  });

  it('reports a logical repeat under a fresh delivery id without dropping it', async () => {
    const h = harness();

    await h.deliver('checkLintGreen');
    await h.deliver('checkLintGreen');

    expect(h.kinds()).toEqual(['ci_check', 'ci_check']);
    expect(h.logs.some((line) => line.event === 'logical_repeat')).toBe(true);
  });

  it('logs identifiers only, never payload text', async () => {
    const h = harness();
    const fixtureBody = (loadFixture('prComment')['comment'] as { body: string }).body;

    await h.deliver('prComment');

    expect(JSON.stringify(h.logs)).not.toContain(fixtureBody);
  });
});

describe('events for another PR in the same repo', () => {
  it('are dropped and counted, never pushed', async () => {
    const h = harness();

    await h.deliver('prComment', {
      mutate: (payload) => {
        (payload['issue'] as Record<string, unknown>)['number'] = 43;
      },
    });

    expect(h.pushed).toEqual([]);
    expect(h.pipeline.counters.dropped_other_pr).toBe(1);
  });
});

describe('head tracking through the pipeline', () => {
  it('never reports the current head green from checks for a superseded head', async () => {
    const h = harness({
      deployWorkflowName: FIXTURE_DEPLOY_WORKFLOW,
      policy: { deployWorkflow: { enabled: true } },
    });

    await h.deliver('checkLintGreen');
    await h.deliver('checkTestGreen');
    // Green for the head that was current when those checks landed: delivery is
    // synchronous, so it was a true signal at the time it was pushed.
    expect(h.pushed.at(-1)).toMatchObject({ kind: 'ci_all_required_green', headSha: FIXTURE_HEAD_SHA, stale: false });

    await h.deliver('prSynchronize');
    expect(h.head.headSha).toBe(FIXTURE_NEXT_HEAD_SHA);
    const afterPush = h.pushed.length;

    // A late green for the head that was just superseded.
    await h.deliver('checkTestGreen', { mutate: onOldHead });
    await h.deliver('deployWorkflow', { mutate: onOldHead });

    const late = h.pushed.slice(afterPush);
    expect(late.length).toBeGreaterThan(0);
    for (const event of late) {
      expect({ kind: event.kind, stale: event.stale, suppressed: event.suppressed }).toEqual({
        kind: event.kind,
        stale: true,
        suppressed: true,
      });
    }
  });

  it('withholds all-required-green while a required check is failing', async () => {
    const h = harness();

    await h.deliver('checkLintGreen');
    await h.deliver('checkTestFailed');
    expect(h.kinds()).toEqual(['ci_check', 'ci_check']);

    await h.deliver('checkTestGreen');
    expect(h.kinds()).toEqual(['ci_check', 'ci_check', 'ci_check', 'ci_all_required_green']);
    expect(h.pushed.at(-1)).toMatchObject({ headSha: FIXTURE_HEAD_SHA, stale: false, suppressed: false });
  });

  it('derives all-required-green again for a new head, once per head', async () => {
    const h = harness();

    await h.deliver('checkLintGreen');
    await h.deliver('checkTestGreen');
    await h.deliver('prSynchronize');
    await h.deliver('checkLintGreen', { mutate: onNewHead });
    await h.deliver('checkTestGreen', { mutate: onNewHead });

    const greens = h.pushed.filter((event) => event.kind === 'ci_all_required_green');
    expect(greens.map((event) => event.headSha)).toEqual([FIXTURE_HEAD_SHA, FIXTURE_NEXT_HEAD_SHA]);
    expect(greens.at(-1)).toMatchObject({ stale: false, suppressed: false });
  });

  it('cannot be rewound by an out-of-order lifecycle delivery', async () => {
    const h = harness();

    await h.deliver('prSynchronize');
    // The synchronize for the earlier push, delivered late: GitHub orders nothing.
    await h.deliver('prSynchronize', {
      mutate: (payload) => {
        onOldHead(payload);
        (payload['pull_request'] as { updated_at: string }).updated_at = '2026-09-07T10:09:00Z';
      },
    });
    expect(h.head.headSha).toBe(FIXTURE_NEXT_HEAD_SHA);

    await h.deliver('checkLintGreen');
    await h.deliver('checkTestGreen');

    const greens = h.pushed.filter((event) => event.headSha === FIXTURE_HEAD_SHA && event.kind !== 'pr_lifecycle');
    expect(greens.length).toBeGreaterThanOrEqual(2);
    for (const event of greens) expect({ stale: event.stale, suppressed: event.suppressed }).toEqual({ stale: true, suppressed: true });
  });

  it('follows a force-push back and reports that head as the current head being green', async () => {
    const h = harness();

    await h.deliver('prSynchronize');
    expect(h.head.headSha).toBe(FIXTURE_NEXT_HEAD_SHA);

    await h.deliver('prSynchronize', {
      mutate: (payload) => {
        onOldHead(payload);
        (payload['pull_request'] as { updated_at: string }).updated_at = '2026-09-07T10:20:00Z';
      },
    });
    expect(h.head.headSha).toBe(FIXTURE_HEAD_SHA);

    await h.deliver('checkLintGreen');
    await h.deliver('checkTestGreen');

    const restored = h.pushed.filter((event) => event.headSha === FIXTURE_HEAD_SHA && event.kind !== 'pr_lifecycle');
    expect(restored.map((event) => event.kind)).toEqual(['ci_check', 'ci_check', 'ci_all_required_green']);
    for (const event of restored) expect({ stale: event.stale, suppressed: event.suppressed }).toEqual({ stale: false, suppressed: false });
  });

  it('keeps a check that outran its own lifecycle and announces it once the head catches up', async () => {
    const h = harness();

    await h.deliver('checkLintGreen', { mutate: onNewHead });
    await h.deliver('checkTestGreen', { mutate: onNewHead });
    await h.deliver('prSynchronize');

    const greens = h.pushed.filter((event) => event.kind === 'ci_all_required_green');
    expect(greens).toHaveLength(2);
    expect(greens[0]).toMatchObject({ headSha: FIXTURE_NEXT_HEAD_SHA, stale: true, suppressed: true });
    expect(greens[1]).toMatchObject({ headSha: FIXTURE_NEXT_HEAD_SHA, stale: false, suppressed: false });
  });

  it('lets a lifecycle delivery correct a seeded head from a clone one push behind', async () => {
    const h = harness();

    // The delivery announcing the push GitHub already has predates the seed.
    await h.deliver('prSynchronize', {
      mutate: (payload) => {
        (payload['pull_request'] as { updated_at: string }).updated_at = '2026-09-07T08:58:00Z';
      },
    });
    expect(h.head.headSha).toBe(FIXTURE_NEXT_HEAD_SHA);

    await h.deliver('checkLintGreen');
    await h.deliver('checkTestGreen');

    const forOldHead = h.pushed.filter((event) => event.headSha === FIXTURE_HEAD_SHA);
    expect(forOldHead.map((event) => event.kind)).toEqual(['ci_check', 'ci_check', 'ci_all_required_green']);
    for (const event of forOldHead) expect({ stale: event.stale, suppressed: event.suppressed }).toEqual({ stale: true, suppressed: true });
  });

  it('never reports a green as confirmed while no head is known', async () => {
    const h = harness({ headSha: null });

    await h.deliver('checkLintGreen');
    await h.deliver('checkTestGreen');

    expect(h.kinds()).toEqual(['ci_check', 'ci_check', 'ci_all_required_green']);
    for (const event of h.pushed) expect(event.suppressed).toBe(true);
  });

  it('never lets a redelivered older success overwrite a newer failure', async () => {
    const h = harness();

    await h.deliver('checkLintGreen');
    await h.deliver('checkTestGreen');
    expect(h.pushed.some((event) => event.kind === 'ci_all_required_green')).toBe(true);

    await h.deliver('checkTestFailed', {
      mutate: (payload) => {
        (payload['check_run'] as { completed_at: string }).completed_at = '2026-09-07T10:10:00Z';
      },
    });
    // GitHub redelivers the earlier success: newest on the wire, oldest in fact.
    await h.deliver('checkTestGreen', {
      mutate: (payload) => {
        (payload['check_run'] as { completed_at: string }).completed_at = '2026-09-07T10:05:00Z';
      },
    });

    expect(h.pushed.filter((event) => event.kind === 'ci_all_required_green')).toHaveLength(1);
  });

  it('routes a check that names no PR by a head this PR has held', async () => {
    const h = harness();

    await h.deliver('checkLintGreen', {
      mutate: (payload) => {
        (payload['check_run'] as Record<string, unknown>)['pull_requests'] = [];
      },
    });

    expect(h.kinds()).toEqual(['ci_check']);
    expect(h.pipeline.counters.unresolved_head).toBe(0);
  });
});

describe('the terminal lifecycle event', () => {
  it('is delivered, then tracking ends and later events are dropped', async () => {
    const h = harness({ headSha: FIXTURE_NEXT_HEAD_SHA });

    await h.deliver('prMerged');

    expect(h.kinds()).toEqual(['pr_lifecycle']);
    expect(h.pushed[0]!.content).toContain('merged');
    expect(h.terminals).toEqual(['merged']);
    expect(h.head.closed).toBe(true);

    await h.deliver('prComment');
    expect(h.kinds()).toEqual(['pr_lifecycle']);
    expect(h.logs.some((line) => line.event === 'delivery_after_end')).toBe(true);
  });
});

describe('counters', () => {
  it('account for everything received', async () => {
    const h = harness({ ciEvents: 'failures' });

    await h.deliver('prComment');
    await h.deliver('checkLintGreen');
    await h.deliver('prComment', { deliveryId: 'dup' });
    await h.deliver('prComment', { deliveryId: 'dup' });

    expect(h.pipeline.counters).toMatchObject({ received: 4, delivered: 2, suppressed: 1, replayed: 1 });
    expect(h.pipeline.lastDeliveryAtIso).not.toBeNull();
  });
});

// Turning a kind off makes the session silent about it, not blind to it: everything
// upstream of the filter still runs.
describe('a kind that is turned off', () => {
  it('still lets synchronize advance the head, so later events are marked stale', async () => {
    const h = harness({ policy: { lifecycle: { ...DEFAULT_POLICY.lifecycle, synchronize: false } } });

    await h.deliver('prSynchronize');

    expect(h.pushed).toEqual([]);
    expect(h.pipeline.counters.suppressed).toBe(1);
    expect(h.head.headSha).toBe(FIXTURE_NEXT_HEAD_SHA);

    await h.deliver('checkLintGreen', { mutate: onOldHead });
    expect(h.pushed.at(-1)).toMatchObject({ kind: 'ci_check', stale: true, suppressed: true });
  });

  it('still records check states, so all-required-green is still announced', async () => {
    const h = harness({ policy: { checks: { enabled: false, wake: 'completed' } } });

    await h.deliver('checkLintGreen');
    await h.deliver('checkTestGreen');

    expect(h.kinds()).toEqual(['ci_all_required_green']);
    expect(h.pipeline.counters.suppressed).toBe(2);
  });

  it('still ends tracking on a merge the session is never told about', async () => {
    const h = harness({
      headSha: FIXTURE_NEXT_HEAD_SHA,
      policy: { lifecycle: { ...DEFAULT_POLICY.lifecycle, merged: false } },
    });

    await h.deliver('prMerged');

    expect(h.pushed).toEqual([]);
    expect(h.terminals).toEqual(['merged']);
    expect(h.head.closed).toBe(true);

    await h.deliver('prComment');
    expect(h.pushed).toEqual([]);
    expect(h.logs.some((line) => line.event === 'delivery_after_end')).toBe(true);
  });

  it('delivers a label only once it is turned on, with the label name fenced', async () => {
    const label = (payload: Record<string, unknown>): void => {
      payload['action'] = 'labeled';
      payload['label'] = { name: 'needs-design' };
    };

    const off = harness();
    await off.deliver('prSynchronize', { mutate: label });
    expect(off.pushed).toEqual([]);
    expect(off.pipeline.counters.suppressed).toBe(1);

    const on = harness({ policy: { lifecycle: { ...DEFAULT_POLICY.lifecycle, labeled: true } } });
    await on.deliver('prSynchronize', { mutate: label });
    expect(on.kinds()).toEqual(['pr_lifecycle']);
    expect(on.pushed[0]!.content).toContain('needs-design');
    expect(on.pushed[0]!.content).toContain('begin untrusted');
  });
});
