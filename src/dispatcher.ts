import type { ServiceConfig } from './config.js';
import { DeliveryDeduper } from './events/dedupe.js';
import { normalizeWebhookAll, type UnresolvedHead } from './events/normalize.js';
import { RequiredChecksTracker } from './events/required-checks.js';
import { PrRegistry } from './registry/registry.js';
import type { ChannelDb } from './store/db.js';
import type { GithubEventName, PrEvent, PrEventKind, PrRef, UnroutedReason } from './types.js';
import { isTerminalLifecycleAction } from './types.js';
import type { SignatureVerifier } from './webhook/signature.js';
import {
  createWebhookServer,
  type BoundAddress,
  type WebhookHeaders,
  type WebhookLogEntry,
  type WebhookServer,
} from './webhook/server.js';

export type DeliveryOutcome =
  | 'dispatched'
  | 'replayed_delivery'
  | 'missing_delivery_id'
  | 'no_pr_events';

export type EventOutcome = 'enqueued' | 'unrouted';

export interface DispatchedEvent {
  readonly kind: PrEventKind;
  readonly prRef: PrRef;
  readonly outcome: EventOutcome;
  readonly reason: UnroutedReason | null;
  readonly eventId: string | null;
  readonly sessionId: string | null;
  readonly stale: boolean;
  readonly suppressedPositiveSignal: boolean;
  readonly terminal: boolean;
  readonly derived: boolean;
}

export interface DeliveryResult {
  readonly deliveryId: string;
  readonly outcome: DeliveryOutcome;
  readonly events: readonly DispatchedEvent[];
}

// Identifiers, states and counts only. No header value, no request body, and no
// GitHub-authored text (comment/review bodies, PR titles) ever reaches a log line.
export interface DispatcherLogEntry {
  readonly component: 'dispatcher' | 'webhook';
  readonly outcome: string;
  readonly deliveryId: string | null;
  readonly eventName: GithubEventName | null;
  readonly repo: string | null;
  readonly prNumber: number | null;
  readonly kind: PrEventKind | null;
  readonly headSha: string | null;
  readonly sessionId: string | null;
  readonly eventId: string | null;
  readonly stale: boolean;
  readonly suppressedPositiveSignal: boolean;
  readonly derived: boolean;
  readonly terminal: boolean;
  readonly detail: string | null;
  readonly duplicateOfDeliveryId: string | null;
  readonly status: number | null;
  readonly bytes: number | null;
  readonly durationMs: number | null;
}

export type DispatcherLogger = (entry: DispatcherLogEntry) => void;

export type DispatcherConfig = Pick<
  ServiceConfig,
  | 'host'
  | 'port'
  | 'maxPayloadBytes'
  | 'repoAllowlist'
  | 'rateLimit'
  | 'requiredChecks'
  | 'commentAuthors'
>;

export interface DispatcherOptions {
  readonly db: ChannelDb;
  readonly config: DispatcherConfig;
  readonly verifier: SignatureVerifier;
  readonly logger?: DispatcherLogger;
  readonly requestTimeoutMs?: number;
  readonly now?: () => Date;
}

export interface Dispatcher {
  readonly registry: PrRegistry;
  readonly webhookServer: WebhookServer;
  handleDelivery(headers: WebhookHeaders, payload: Record<string, unknown>): DeliveryResult;
  listen(): Promise<BoundAddress>;
  close(): Promise<void>;
}

export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const { db, config, verifier } = options;
  const now = options.now ?? (() => new Date());
  const log = options.logger ?? defaultLogger;
  const registry = new PrRegistry(db, { now });
  const deduper = new DeliveryDeduper(db);
  const requiredChecks = new RequiredChecksTracker(db, config.requiredChecks);

  // One transaction for the whole delivery: the X-GitHub-Delivery row that makes a
  // replay a no-op is committed with the events it enqueued, never before them, and the
  // check states the tracker writes roll back with them. A failure anywhere rolls the
  // delivery id back too, so GitHub's redelivery of the same id (the only recovery it
  // offers) is processed instead of dropped as a replay.
  function handleDelivery(headers: WebhookHeaders, payload: Record<string, unknown>): DeliveryResult {
    const receivedAtIso = now().toISOString();
    const context = { deliveryId: headers.deliveryId, eventName: headers.eventName, repo: headers.repo };
    const logBuffer: DispatcherLogEntry[] = [];

    try {
      const result = db.transaction((): DeliveryResult => {
        const verdict = deduper.accept({ ...context, receivedAtIso });
        if (!verdict.accepted) {
          logBuffer.push(entry({ ...context, outcome: verdict.reason }));
          return { deliveryId: headers.deliveryId, outcome: verdict.reason, events: [] };
        }

        const unresolved: UnresolvedHead[] = [];
        const events = normalizeWebhookAll(headers.eventName, payload, {
          resolvePrsByHead: (repo, headSha) => registry.findPrsByHead(repo, headSha),
          onUnresolvedHead: (head) => unresolved.push(head),
          now: () => receivedAtIso,
          commentAuthors: config.commentAuthors,
        });
        if (events.length === 0) {
          // A delivery no route can account for is dropped, but never silently: the head
          // it was about is the only handle an operator has on it.
          const head = unresolved[0];
          logBuffer.push(
            entry({
              ...context,
              outcome: 'no_pr_events',
              ...(head ? { kind: head.kind, headSha: head.headSha, detail: 'unresolved_head' } : {}),
            }),
          );
          return { deliveryId: headers.deliveryId, outcome: 'no_pr_events', events: [] };
        }

        const dispatched: DispatchedEvent[] = [];
        for (const event of events) {
          const logical = deduper.noteLogicalState(event, headers.deliveryId);
          const result = dispatch(event, context, receivedAtIso, false, logical?.previousDeliveryId ?? null, logBuffer);
          dispatched.push(result);

          if (result.outcome !== 'enqueued') continue;
          // The tracker only follows PRs that actually have a session listening, and only
          // once the event itself was accepted, so it never derives green for dead routes.
          const allGreen = requiredChecks.observe(event, registry.currentHead(event.prRef));
          if (allGreen) dispatched.push(dispatch(allGreen, context, receivedAtIso, true, null, logBuffer));
          if (result.terminal) requiredChecks.forget(event.prRef);
        }
        return { deliveryId: headers.deliveryId, outcome: 'dispatched', events: dispatched };
      });
      for (const logEntry of logBuffer) log(logEntry);
      return result;
    } catch (error) {
      log(entry({ ...context, outcome: 'delivery_failed', detail: errorLabel(error) }));
      throw error;
    }
  }

  function dispatch(
    event: PrEvent,
    context: LogContext,
    receivedAtIso: string,
    derived: boolean,
    duplicateOfDeliveryId: string | null,
    logBuffer: DispatcherLogEntry[],
  ): DispatchedEvent {
    const terminal = event.kind === 'pr_lifecycle' && isTerminalLifecycleAction(event.action);
    const routed = registry.route(event, { deliveryId: context.deliveryId, receivedAtIso });
    const base = {
      kind: event.kind,
      prRef: event.prRef,
      terminal,
      derived,
    };
    const common = {
      ...context,
      prNumber: event.prRef.prNumber,
      kind: event.kind,
      headSha: event.headSha,
      derived,
      terminal,
      duplicateOfDeliveryId,
    };

    if (routed.outcome === 'unrouted') {
      logBuffer.push(entry({ ...common, outcome: 'unrouted', detail: routed.reason }));
      return {
        ...base,
        outcome: 'unrouted',
        reason: routed.reason,
        eventId: null,
        sessionId: null,
        stale: false,
        suppressedPositiveSignal: false,
      };
    }

    logBuffer.push(
      entry({
        ...common,
        outcome: 'enqueued',
        sessionId: routed.envelope.sessionId,
        eventId: routed.envelope.id,
        stale: routed.stale,
        suppressedPositiveSignal: routed.suppressedPositiveSignal,
        detail: terminal ? (routed.applied.closed ? 'route_closed' : 'route_already_closed') : null,
      }),
    );
    return {
      ...base,
      outcome: 'enqueued',
      reason: null,
      eventId: routed.envelope.id,
      sessionId: routed.envelope.sessionId,
      stale: routed.stale,
      suppressedPositiveSignal: routed.suppressedPositiveSignal,
    };
  }

  const webhookServer = createWebhookServer({
    config,
    verifier,
    handler: async (headers, payload) => {
      handleDelivery(headers, payload);
    },
    logger: (webhookEntry: WebhookLogEntry) => log(fromWebhook(webhookEntry)),
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
  });

  return {
    registry,
    webhookServer,
    handleDelivery,
    listen: () => webhookServer.listen(),
    close: () => webhookServer.close(),
  };
}

interface LogContext {
  readonly deliveryId: string;
  readonly eventName: GithubEventName;
  readonly repo: string;
}

function entry(fields: Partial<DispatcherLogEntry> & { outcome: string }): DispatcherLogEntry {
  return {
    component: 'dispatcher',
    deliveryId: null,
    eventName: null,
    repo: null,
    prNumber: null,
    kind: null,
    headSha: null,
    sessionId: null,
    eventId: null,
    stale: false,
    suppressedPositiveSignal: false,
    derived: false,
    terminal: false,
    detail: null,
    duplicateOfDeliveryId: null,
    status: null,
    bytes: null,
    durationMs: null,
    ...fields,
  };
}

function fromWebhook(webhookEntry: WebhookLogEntry): DispatcherLogEntry {
  return entry({
    component: 'webhook',
    outcome: webhookEntry.outcome,
    deliveryId: webhookEntry.deliveryId,
    eventName: webhookEntry.eventName,
    repo: webhookEntry.repo,
    detail: webhookEntry.detail,
    status: webhookEntry.status,
    bytes: webhookEntry.bytes,
    durationMs: webhookEntry.durationMs,
  });
}

// Never the message: it can carry paths or payload fragments. The class name is enough
// to tell a busy database from a programming error.
function errorLabel(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

function defaultLogger(logEntry: DispatcherLogEntry): void {
  process.stderr.write(`${JSON.stringify(logEntry)}\n`);
}
