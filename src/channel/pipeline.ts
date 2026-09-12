import { renderEventPrompt } from '../delivery/prompt.js';
import type { DeliveryDeduper } from '../events/dedupe.js';
import type { HeadTracker } from '../events/head.js';
import { newEventId } from '../events/ids.js';
import type { BotComments } from '../events/normalize.js';
import { normalizeWebhookAll } from '../events/normalize.js';
import type { RequiredChecksTracker } from '../events/required-checks.js';
import type { Logger } from '../log.js';
import { noopLogger } from '../log.js';
import type { EventEnvelope, PrEvent, PrRef, TerminalLifecycleAction } from '../types.js';
import { isTerminalLifecycleAction, prKey } from '../types.js';
import type { DeliveryHeaders } from '../webhook/listener.js';
import { describeEvent } from './describe.js';
import type { DeliveryPolicy } from './filter.js';
import { worthWaking } from './filter.js';
import { eventMeta, type ChannelNotifier } from './server.js';

export interface PipelineCounters {
  received: number;
  delivered: number;
  suppressed: number;
  dropped_other_pr: number;
  replayed: number;
  unresolved_head: number;
  notify_failed: number;
}

export interface PipelineOptions {
  readonly prRef: PrRef;
  readonly head: HeadTracker;
  readonly deduper: DeliveryDeduper;
  readonly requiredChecks: RequiredChecksTracker;
  readonly notifier: ChannelNotifier;
  readonly policy: DeliveryPolicy;
  readonly commentAuthors: ReadonlySet<string> | null;
  readonly botComments: BotComments;
  readonly deployWorkflowName: string | null;
  readonly logger?: Logger;
  readonly now?: () => Date;
  // Called after the terminal event has been handed to the session, so tracking can stop.
  readonly onTerminal?: (action: TerminalLifecycleAction) => void;
}

export interface Pipeline {
  handleDelivery(headers: DeliveryHeaders, payload: Record<string, unknown>): Promise<void>;
  readonly counters: Readonly<PipelineCounters>;
  readonly lastDeliveryAtIso: string | null;
}

export function createPipeline(options: PipelineOptions): Pipeline {
  const log = options.logger ?? noopLogger;
  const now = options.now ?? (() => new Date());
  const counters: PipelineCounters = {
    received: 0,
    delivered: 0,
    suppressed: 0,
    dropped_other_pr: 0,
    replayed: 0,
    unresolved_head: 0,
    notify_failed: 0,
  };
  let lastDeliveryAtIso: string | null = null;
  let ended = false;

  async function handleDelivery(headers: DeliveryHeaders, payload: Record<string, unknown>): Promise<void> {
    counters.received += 1;
    lastDeliveryAtIso = now().toISOString();

    const verdict = options.deduper.accept({
      deliveryId: headers.deliveryId,
      eventName: headers.eventName,
      repo: headers.repo,
      receivedAtIso: lastDeliveryAtIso,
    });
    if (!verdict.accepted) {
      if (verdict.reason === 'replayed_delivery') counters.replayed += 1;
      log('debug', 'delivery_dropped', { reason: verdict.reason, delivery_id: headers.deliveryId });
      return;
    }

    // Tracking that has ended keeps answering 202 so gh does not retry, but nothing
    // reaches the session: the PR is finished and the hook is on its way out.
    if (ended) {
      log('debug', 'delivery_after_end', { delivery_id: headers.deliveryId });
      return;
    }

    const events = normalizeWebhookAll(headers.eventName, payload, {
      // A check_run names no PR for fork PRs and for runs not triggered by a
      // pull_request event, so the head sha is all there is to go on. Every head this PR
      // has held counts: a check can outrun the synchronize for its own head.
      resolvePrsByHead: (repo, headSha) => options.head.prsByHead(repo, headSha),
      onUnresolvedHead: () => {
        counters.unresolved_head += 1;
      },
      commentAuthors: options.commentAuthors,
      botComments: options.botComments,
      deployWorkflowName: options.deployWorkflowName,
    });

    for (const event of events) {
      await handleEvent(event, verdict.deliveryId, lastDeliveryAtIso);
    }
  }

  async function handleEvent(event: PrEvent, deliveryId: string, receivedAtIso: string): Promise<void> {
    if (event.prRef.repo !== options.prRef.repo || event.prRef.prNumber !== options.prRef.prNumber) {
      counters.dropped_other_pr += 1;
      log('debug', 'event_other_pr', { pr: prKey(event.prRef), kind: event.kind, delivery_id: deliveryId });
      return;
    }

    const duplicate = options.deduper.noteLogicalState(event, deliveryId);
    if (duplicate !== null) {
      log('debug', 'logical_repeat', { kind: event.kind, delivery_id: deliveryId, previous_delivery_id: duplicate.previousDeliveryId });
    }

    const classification = options.head.classify(event);
    options.head.apply(event);
    const currentHead = options.head.headSha;

    await push(envelopeFor(event, deliveryId, receivedAtIso, classification.stale), currentHead);

    const derived = options.requiredChecks.observe(event, currentHead);
    if (derived !== null) {
      const derivedStale = options.head.classify(derived).stale;
      await push(envelopeFor(derived, deliveryId, receivedAtIso, derivedStale), currentHead);
    }

    if (event.kind === 'pr_lifecycle' && isTerminalLifecycleAction(event.action)) {
      ended = true;
      options.requiredChecks.forget();
      options.onTerminal?.(event.action);
    }
  }

  function envelopeFor(event: PrEvent, deliveryId: string, receivedAtIso: string, stale: boolean): EventEnvelope {
    return {
      id: newEventId(),
      deliveryId,
      prRef: event.prRef,
      receivedAtIso,
      headSha: event.headSha,
      stale,
      kind: event.kind,
      payload: event,
    } as EventEnvelope;
  }

  async function push(envelope: EventEnvelope, currentHead: string | null): Promise<void> {
    if (!worthWaking(envelope, options.policy)) {
      counters.suppressed += 1;
      log('debug', 'event_suppressed', { kind: envelope.kind, event_id: envelope.id });
      return;
    }
    // Staleness is re-decided here against the head held now, which is what a green for a
    // head the PR has already left must be measured against.
    const described = describeEvent(envelope, currentHead);
    const delivered: EventEnvelope = { ...envelope, stale: described.stale } as EventEnvelope;
    try {
      await options.notifier.notification({
        method: 'notifications/claude/channel',
        params: { content: renderEventPrompt(delivered), meta: eventMeta(delivered) },
      });
    } catch (error) {
      // There is no queue: a push that fails is counted and logged, never retried.
      counters.notify_failed += 1;
      log('error', 'notify_failed', { kind: envelope.kind, event_id: envelope.id, error: errorName(error) });
      return;
    }
    counters.delivered += 1;
    log('info', 'event_delivered', {
      kind: delivered.kind,
      event_id: delivered.id,
      head_sha: delivered.headSha,
      stale: delivered.stale,
      suppressed_positive_signal: described.positiveSignalSuppressed,
    });
  }

  return {
    handleDelivery,
    get counters() {
      return counters;
    },
    get lastDeliveryAtIso() {
      return lastDeliveryAtIso;
    },
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
