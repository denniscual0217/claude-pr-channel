import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelManager } from '../src/channel/manager.js';
import { describeEvent, routeHeadSha } from '../src/channel/describe.js';
import { SessionQueue } from '../src/channel/queue.js';
import { WebhookSecret } from '../src/config.js';
import { createDispatcher, type Dispatcher, type DispatcherLogEntry } from '../src/dispatcher.js';
import { ChannelDb } from '../src/store/db.js';
import { UNTRUSTED_TEXT_NOTICE } from '../src/types.js';
import {
  FIXTURE_HEAD_SHA,
  FIXTURE_NEXT_HEAD_SHA,
  FIXTURE_PR,
  FIXTURE_REPO,
  FIXTURE_REQUIRED_CHECKS,
  TEST_WEBHOOK_SECRET,
  loadFixture,
  postDelivery,
  setHeadSha,
  signBody,
  signDelivery,
  type FixtureName,
  type SignDeliveryOptions,
} from './fixtures/index.js';

const SESSION = 'worker-session-1';
const OTHER_SESSION = 'worker-session-2';
const LEASE_MS = 60_000;
const CLOCK = new Date('2026-09-07T09:00:00.000Z');

interface PolledEvent {
  readonly id: string;
  readonly kind: string;
  readonly headSha: string | null;
  readonly currentHeadSha: string | null;
  readonly stale: boolean;
  readonly headConfirmed: boolean;
  readonly positiveSignalSuppressed: boolean;
  readonly payload: Record<string, unknown>;
}

interface PollResult {
  readonly events: PolledEvent[];
  readonly untrustedTextNotice: string;
  readonly remainingUnacked: number;
  readonly channel: { state: string; closed: boolean; unacked: number };
}

let db: ChannelDb;
let dispatcher: Dispatcher;
let baseUrl: string;
let logs: DispatcherLogEntry[];
let closers: Array<() => Promise<void>>;

// The channel reads its session's queue directly, so the integration tests observe the
// same surface it does rather than a transport that no longer exists.
async function connect(sessionId: string): Promise<SessionQueue> {
  return new SessionQueue(db, sessionId, { leaseMs: LEASE_MS });
}

async function poll(queue: SessionQueue): Promise<PollResult> {
  const { events } = queue.poll();
  const described = events.map((event) => describeEvent(event, routeHeadSha(db, event.prRef)));
  const status = new ChannelManager(db).status(queue.sessionId);
  return {
    events: described as unknown as PolledEvent[],
    untrustedTextNotice: UNTRUSTED_TEXT_NOTICE,
    remainingUnacked: status.unacked,
    channel: { state: status.state, closed: status.route?.closed ?? false, unacked: status.unacked },
  };
}

async function ack(queue: SessionQueue, eventIds: string[]): Promise<Record<string, unknown>> {
  const result = queue.ack(eventIds);
  return { ...result, remainingUnacked: queue.countUnacked() };
}

async function channelStatus(queue: SessionQueue): Promise<Record<string, unknown>> {
  const manager = new ChannelManager(db);
  return manager.status(queue.sessionId) as unknown as Record<string, unknown>;
}

async function deliver(name: FixtureName, options: SignDeliveryOptions = {}): Promise<number> {
  const response = await postDelivery(baseUrl, signDelivery(name, options));
  return response.status;
}

beforeEach(async () => {
  db = ChannelDb.open(':memory:');
  logs = [];
  closers = [];
  dispatcher = createDispatcher({
    db,
    config: {
      host: '127.0.0.1',
      port: 0,
      maxPayloadBytes: 1_048_576,
      repoAllowlist: new Set([FIXTURE_REPO]),
      rateLimit: { maxDeliveries: 500, windowMs: 60_000 },
      requiredChecks: [...FIXTURE_REQUIRED_CHECKS],
  commentAuthors: null,
  botComments: 'handle' as const,
    },
    verifier: new WebhookSecret(TEST_WEBHOOK_SECRET),
    logger: (entry) => logs.push(entry),
    // Fixed, so every route this suite registers is stamped with one known instant.
    now: () => CLOCK,
  });
  const address = await dispatcher.listen();
  expect(address.host).toBe('127.0.0.1');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  for (const close of closers.reverse()) await close();
  await dispatcher.close();
  db.close();
});

describe('signed delivery to channel', () => {
  it('lands a signed PR comment in the registered session and nowhere else', async () => {
    dispatcher.registry.register({ prRef: FIXTURE_PR, sessionId: SESSION, headSha: FIXTURE_HEAD_SHA });
    const worker = await connect(SESSION);
    const bystander = await connect(OTHER_SESSION);

    expect(await deliver('prComment')).toBe(202);

    const polled = await poll(worker);
    expect(polled.events).toHaveLength(1);
    const event = polled.events[0]!;
    expect(event.kind).toBe('pr_comment');
    const fixtureBody = (loadFixture('prComment')['comment'] as { body: string }).body;
    expect(event.payload['untrustedBody']).toEqual({ untrusted: true, text: fixtureBody });
    expect(polled.untrustedTextNotice).toContain(UNTRUSTED_TEXT_NOTICE);
    expect((await poll(bystander)).events).toEqual([]);

    const acked = await ack(worker, [event.id]);
    expect(acked).toMatchObject({ acked: [event.id], remainingUnacked: 0 });
    expect((await poll(worker)).events).toEqual([]);
  });

  it('carries reviews, inline review comments and the Temploy workflow run through to the session', async () => {
    dispatcher.registry.register({ prRef: FIXTURE_PR, sessionId: SESSION, headSha: FIXTURE_HEAD_SHA });
    const worker = await connect(SESSION);

    expect(await deliver('prReview')).toBe(202);
    expect(await deliver('prReviewComment')).toBe(202);
    expect(await deliver('temployWorkflow')).toBe(202);

    const polled = await poll(worker);
    expect(polled.events.map((event) => event.kind)).toEqual(['pr_review', 'pr_review_comment', 'temploy_workflow']);
    expect(polled.events[2]!.payload['state']).toEqual({ status: 'completed', conclusion: 'success' });
    expect(polled.events.every((event) => event.stale === false)).toBe(true);
  });

  it('drops a replayed X-GitHub-Delivery without enqueueing it twice', async () => {
    dispatcher.registry.register({ prRef: FIXTURE_PR, sessionId: SESSION, headSha: FIXTURE_HEAD_SHA });
    const worker = await connect(SESSION);
    const delivery = signDelivery('prComment', { deliveryId: 'replayed-delivery-id' });

    const first = await postDelivery(baseUrl, delivery);
    const replay = await postDelivery(baseUrl, delivery);

    expect([first.status, replay.status]).toEqual([202, 202]);
    expect((await poll(worker)).events).toHaveLength(1);
    expect(logs.some((entry) => entry.outcome === 'replayed_delivery')).toBe(true);
  });

  it('rejects a tampered body with 401 and stores nothing', async () => {
    dispatcher.registry.register({ prRef: FIXTURE_PR, sessionId: SESSION, headSha: FIXTURE_HEAD_SHA });
    const worker = await connect(SESSION);

    const honest = signDelivery('prComment', { deliveryId: 'tampered-delivery-id' });
    const tampered = { ...honest, body: honest.body.replace('"created"', '"edited"') };
    expect(signBody(tampered.body)).not.toBe(honest.headers['X-Hub-Signature-256']);

    const response = await postDelivery(baseUrl, tampered);
    expect(response.status).toBe(401);
    expect((await poll(worker)).events).toEqual([]);
    expect(db.hasDelivery('tampered-delivery-id')).toBe(false);
  });
});

describe('head tracking through the wire', () => {
  it('never reports the current head green from checks for a superseded head', async () => {
    dispatcher.registry.register({ prRef: FIXTURE_PR, sessionId: SESSION, headSha: FIXTURE_HEAD_SHA });
    const worker = await connect(SESSION);

    expect(await deliver('checkLintGreen')).toBe(202);
    expect(await deliver('checkTestGreen')).toBe(202);
    expect(await deliver('prSynchronize')).toBe(202);
    expect(dispatcher.registry.currentHead(FIXTURE_PR)).toBe(FIXTURE_NEXT_HEAD_SHA);
    // A late green for the head that was just superseded.
    expect(await deliver('checkTestGreen', { mutate: (payload) => setHeadSha(payload, FIXTURE_HEAD_SHA) })).toBe(202);

    const polled = await poll(worker);
    // Green derived before the push: the head moved while it sat in the queue, so poll
    // time re-evaluates it as stale rather than as the current head being green.
    const allGreen = polled.events.find((event) => event.kind === 'ci_all_required_green')!;
    expect(allGreen.headSha).toBe(FIXTURE_HEAD_SHA);
    expect(allGreen.currentHeadSha).toBe(FIXTURE_NEXT_HEAD_SHA);
    expect(allGreen).toMatchObject({ stale: true, positiveSignalSuppressed: true });

    const oldHeadSignals = polled.events.filter((event) => event.headSha === FIXTURE_HEAD_SHA);
    expect(oldHeadSignals.length).toBeGreaterThanOrEqual(4);
    for (const event of oldHeadSignals) {
      expect({ kind: event.kind, stale: event.stale, suppressed: event.positiveSignalSuppressed }).toEqual({
        kind: event.kind,
        stale: true,
        suppressed: true,
      });
    }
    expect(polled.events.some((event) => !event.stale && event.kind === 'ci_all_required_green')).toBe(false);
  });

  it('withholds all-required-green while a required check is failing', async () => {
    dispatcher.registry.register({ prRef: FIXTURE_PR, sessionId: SESSION, headSha: FIXTURE_HEAD_SHA });
    const worker = await connect(SESSION);

    expect(await deliver('checkLintGreen')).toBe(202);
    expect(await deliver('checkTestFailed')).toBe(202);
    expect((await poll(worker)).events.map((event) => event.kind)).toEqual(['ci_check', 'ci_check']);

    expect(await deliver('checkTestGreen')).toBe(202);
    const recovered = (await poll(worker)).events;
    expect(recovered.map((event) => event.kind)).toEqual(['ci_check', 'ci_all_required_green']);
    expect(recovered[1]).toMatchObject({ headSha: FIXTURE_HEAD_SHA, stale: false, positiveSignalSuppressed: false });
  });

  it('reports the new head green once its own required checks pass', async () => {
    dispatcher.registry.register({ prRef: FIXTURE_PR, sessionId: SESSION, headSha: FIXTURE_HEAD_SHA });
    const worker = await connect(SESSION);
    const onNewHead = (payload: Record<string, unknown>) => setHeadSha(payload, FIXTURE_NEXT_HEAD_SHA);

    expect(await deliver('prSynchronize')).toBe(202);
    expect(await deliver('checkLintGreen', { mutate: onNewHead })).toBe(202);
    expect(await deliver('checkTestGreen', { mutate: onNewHead })).toBe(202);

    const allGreen = (await poll(worker)).events.find((event) => event.kind === 'ci_all_required_green')!;
    expect(allGreen).toMatchObject({
      headSha: FIXTURE_NEXT_HEAD_SHA,
      stale: false,
      positiveSignalSuppressed: false,
    });
  });
});

describe('an out-of-order lifecycle delivery', () => {
  it('cannot rewind the head, so a green for the superseded head stays suppressed', async () => {
    dispatcher.registry.register({ prRef: FIXTURE_PR, sessionId: SESSION, headSha: FIXTURE_HEAD_SHA });
    const worker = await connect(SESSION);

    expect(await deliver('prSynchronize')).toBe(202);
    // The synchronize for the earlier push, delivered late: GitHub orders nothing.
    expect(
      await deliver('prSynchronize', {
        mutate: (payload) => {
          setHeadSha(payload, FIXTURE_HEAD_SHA);
          (payload['pull_request'] as { updated_at: string }).updated_at = '2026-09-07T10:09:00Z';
        },
      }),
    ).toBe(202);
    expect(dispatcher.registry.currentHead(FIXTURE_PR)).toBe(FIXTURE_NEXT_HEAD_SHA);

    expect(await deliver('checkLintGreen')).toBe(202);
    expect(await deliver('checkTestGreen')).toBe(202);

    const greens = (await poll(worker)).events.filter(
      (event) => event.headSha === FIXTURE_HEAD_SHA && event.kind !== 'pr_lifecycle',
    );
    expect(greens.length).toBeGreaterThanOrEqual(2);
    for (const event of greens) {
      expect({ kind: event.kind, stale: event.stale, suppressed: event.positiveSignalSuppressed }).toEqual({
        kind: event.kind,
        stale: true,
        suppressed: true,
      });
    }
  });
});

describe('a force-push back to an earlier commit', () => {
  it('puts the head back and reports greens for it as the current head being green', async () => {
    dispatcher.registry.register({ prRef: FIXTURE_PR, sessionId: SESSION, headSha: FIXTURE_HEAD_SHA });
    const worker = await connect(SESSION);

    expect(await deliver('prSynchronize')).toBe(202);
    expect(dispatcher.registry.currentHead(FIXTURE_PR)).toBe(FIXTURE_NEXT_HEAD_SHA);

    // The bad commit is dropped and the branch is force-pushed back to the earlier one.
    expect(
      await deliver('prSynchronize', {
        mutate: (payload) => {
          setHeadSha(payload, FIXTURE_HEAD_SHA);
          (payload['pull_request'] as { updated_at: string }).updated_at = '2026-09-07T10:20:00Z';
        },
      }),
    ).toBe(202);
    expect(dispatcher.registry.currentHead(FIXTURE_PR)).toBe(FIXTURE_HEAD_SHA);

    expect(await deliver('checkLintGreen')).toBe(202);
    expect(await deliver('checkTestGreen')).toBe(202);

    const polled = await poll(worker);
    const restored = polled.events.filter(
      (event) => event.headSha === FIXTURE_HEAD_SHA && event.kind !== 'pr_lifecycle',
    );
    expect(restored.map((event) => event.kind)).toEqual(['ci_check', 'ci_check', 'ci_all_required_green']);
    for (const event of restored) {
      expect({ kind: event.kind, stale: event.stale, suppressed: event.positiveSignalSuppressed }).toEqual({
        kind: event.kind,
        stale: false,
        suppressed: false,
      });
    }
    expect(await channelStatus(worker)).toMatchObject({ route: { headSha: FIXTURE_HEAD_SHA } });
  });
});

describe('a check that outruns the synchronize', () => {
  it('is delivered as the current head being green once the head catches up', async () => {
    dispatcher.registry.register({ prRef: FIXTURE_PR, sessionId: SESSION, headSha: FIXTURE_HEAD_SHA });
    const worker = await connect(SESSION);
    const onNewHead = (payload: Record<string, unknown>) => setHeadSha(payload, FIXTURE_NEXT_HEAD_SHA);

    // Both checks for the new head land before the pull_request delivery that moves it.
    expect(await deliver('checkLintGreen', { mutate: onNewHead })).toBe(202);
    expect(await deliver('checkTestGreen', { mutate: onNewHead })).toBe(202);
    expect(await deliver('prSynchronize')).toBe(202);

    const polled = await poll(worker);
    const forNewHead = polled.events.filter((event) => event.headSha === FIXTURE_NEXT_HEAD_SHA);
    expect(forNewHead.map((event) => event.kind)).toEqual([
      'ci_check',
      'ci_check',
      'ci_all_required_green',
      'pr_lifecycle',
    ]);
    for (const event of forNewHead) {
      expect({ kind: event.kind, stale: event.stale, suppressed: event.positiveSignalSuppressed }).toEqual({
        kind: event.kind,
        stale: false,
        suppressed: false,
      });
    }
    expect(forNewHead.every((event) => event.headConfirmed)).toBe(true);
  });
});

describe('a route whose head was never established', () => {
  it('delivers greens but never as a confirmed current-head green', async () => {
    dispatcher.registry.register({ prRef: FIXTURE_PR, sessionId: SESSION });
    const worker = await connect(SESSION);

    expect(await deliver('checkLintGreen')).toBe(202);
    expect(await deliver('checkTestGreen')).toBe(202);

    const polled = await poll(worker);
    expect(polled.events.map((event) => event.kind)).toEqual(['ci_check', 'ci_check', 'ci_all_required_green']);
    for (const event of polled.events) {
      expect({ kind: event.kind, confirmed: event.headConfirmed, suppressed: event.positiveSignalSuppressed }).toEqual({
        kind: event.kind,
        confirmed: false,
        suppressed: true,
      });
    }
    expect(polled.events.every((event) => event.currentHeadSha === null)).toBe(true);
  });
});

describe('a suppressed green the session is still holding', () => {
  it('is followed by a confirmed green for the head, ack or no ack', async () => {
    dispatcher.registry.register({ prRef: FIXTURE_PR, sessionId: SESSION, headSha: FIXTURE_HEAD_SHA });
    const worker = await connect(SESSION);
    const onNewHead = (payload: Record<string, unknown>) => setHeadSha(payload, FIXTURE_NEXT_HEAD_SHA);

    expect(await deliver('checkLintGreen', { mutate: onNewHead })).toBe(202);
    expect(await deliver('checkTestGreen', { mutate: onNewHead })).toBe(202);

    const history = await poll(worker);
    expect(history.events.map((event) => event.kind)).toEqual(['ci_check', 'ci_check', 'ci_all_required_green']);
    expect(history.events.at(-1)).toMatchObject({ headConfirmed: false, positiveSignalSuppressed: true });

    // Handling takes as long as it takes: the synchronize lands before the ack does.
    expect(await deliver('prSynchronize')).toBe(202);
    expect(dispatcher.registry.currentHead(FIXTURE_PR)).toBe(FIXTURE_NEXT_HEAD_SHA);

    const green = (await poll(worker)).events.find((event) => event.kind === 'ci_all_required_green');
    expect(green).toMatchObject({
      headSha: FIXTURE_NEXT_HEAD_SHA,
      currentHeadSha: FIXTURE_NEXT_HEAD_SHA,
      stale: false,
      headConfirmed: true,
      positiveSignalSuppressed: false,
    });
    await ack(worker, history.events.map((event) => event.id));
  });
});

describe('a registration head from a clone one push behind GitHub', () => {
  it('is corrected by the pull_request delivery, so only the real head reads as green', async () => {
    // The worker registered `git rev-parse HEAD` from a clone that never fetched the push
    // GitHub already has, and the delivery announcing that push predates the registration.
    dispatcher.registry.register({ prRef: FIXTURE_PR, sessionId: SESSION, headSha: FIXTURE_HEAD_SHA });
    const worker = await connect(SESSION);

    expect(
      await deliver('prSynchronize', {
        mutate: (payload) => {
          (payload['pull_request'] as { updated_at: string }).updated_at = '2026-09-07T08:58:00Z';
        },
      }),
    ).toBe(202);
    expect(dispatcher.registry.currentHead(FIXTURE_PR)).toBe(FIXTURE_NEXT_HEAD_SHA);

    expect(await deliver('checkLintGreen')).toBe(202);
    expect(await deliver('checkTestGreen')).toBe(202);

    const polled = await poll(worker);
    const forOldHead = polled.events.filter((event) => event.headSha === FIXTURE_HEAD_SHA);
    expect(forOldHead.map((event) => event.kind)).toEqual(['ci_check', 'ci_check', 'ci_all_required_green']);
    for (const event of forOldHead) {
      expect({ kind: event.kind, confirmed: event.headConfirmed, suppressed: event.positiveSignalSuppressed }).toEqual({
        kind: event.kind,
        confirmed: false,
        suppressed: true,
      });
    }
  });
});

describe('a green head the session only ever saw as history', () => {
  it('is announced as the current head being green once the head lands', async () => {
    // Registration without --head: the contract allows it, so nothing can confirm a head
    // until the first pull_request delivery arrives.
    dispatcher.registry.register({ prRef: FIXTURE_PR, sessionId: SESSION });
    const worker = await connect(SESSION);

    expect(await deliver('checkLintGreen')).toBe(202);
    expect(await deliver('checkTestGreen')).toBe(202);

    const history = await poll(worker);
    expect(history.events.map((event) => event.kind)).toEqual(['ci_check', 'ci_check', 'ci_all_required_green']);
    expect(history.events.every((event) => event.positiveSignalSuppressed)).toBe(true);
    // Handle, then ack: the session used those greens as history, exactly as told.
    await ack(worker, history.events.map((event) => event.id));

    expect(await deliver('prSynchronize', { mutate: (payload) => setHeadSha(payload, FIXTURE_HEAD_SHA) })).toBe(202);
    expect(dispatcher.registry.currentHead(FIXTURE_PR)).toBe(FIXTURE_HEAD_SHA);

    const green = (await poll(worker)).events.find((event) => event.kind === 'ci_all_required_green');
    expect(green).toMatchObject({
      headSha: FIXTURE_HEAD_SHA,
      currentHeadSha: FIXTURE_HEAD_SHA,
      stale: false,
      headConfirmed: true,
      positiveSignalSuppressed: false,
    });
  });
});

describe('teardown', () => {
  it('delivers the terminal merged event and then stops routing to the PR', async () => {
    dispatcher.registry.register({ prRef: FIXTURE_PR, sessionId: SESSION, headSha: FIXTURE_NEXT_HEAD_SHA });
    const worker = await connect(SESSION);

    expect(await deliver('prMerged')).toBe(202);

    const polled = await poll(worker);
    const terminal = polled.events.at(-1)!;
    expect(terminal.kind).toBe('pr_lifecycle');
    expect(terminal.payload).toMatchObject({ action: 'merged' });
    expect(polled.channel).toMatchObject({ state: 'closed', closed: true });
    expect(db.findOpenRoute(FIXTURE_PR)).toBeNull();
    expect(db.getRoute(FIXTURE_PR)).toMatchObject({ closed: true, lifecycle: 'merged' });

    expect(await deliver('prComment')).toBe(202);
    expect((await poll(worker)).events).toEqual([]);
    expect(db.countUnrouted(FIXTURE_PR)).toBe(1);

    await ack(worker, [terminal.id]);
    expect(await channelStatus(worker)).toMatchObject({ state: 'closed', drained: true, unacked: 0 });
  });

  it('records an event for an unregistered PR as unrouted and delivers it to nobody', async () => {
    const worker = await connect(SESSION);

    expect(await deliver('prComment')).toBe(202);

    expect((await poll(worker)).events).toEqual([]);
    expect(db.countUnrouted(FIXTURE_PR)).toBe(1);
    expect(db.countPending(SESSION)).toBe(0);
    expect(logs.some((entry) => entry.outcome === 'unrouted' && entry.detail === 'no_route')).toBe(true);
  });
});
