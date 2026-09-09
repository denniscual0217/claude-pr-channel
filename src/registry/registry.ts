import { normalizeRepo } from '../config.js';
import { newEventId, type ChannelDb } from '../store/db.js';
import type {
  EventEnvelope,
  PrEvent,
  PrLifecycleEvent,
  PrRef,
  RouteLifecycleState,
  SessionRoute,
  UnroutedReason,
} from '../types.js';
import { isPositiveHeadSignal, isTerminalLifecycleAction, lifecycleStateAfter } from '../types.js';

export interface RegisterInput {
  readonly prRef: PrRef;
  readonly sessionId: string;
  readonly headSha?: string | null;
  readonly lifecycle?: RouteLifecycleState;
  readonly workerDir?: string | null;
  // Explicit takeover of a route another session still holds (e.g. that session died).
  readonly replace?: boolean;
}

export type RegisterResult =
  | {
      readonly ok: true;
      readonly route: SessionRoute;
      readonly replaced: SessionRoute | null;
      // A head the caller asserted that was refused because a webhook already established
      // a different one. The registration itself still succeeds.
      readonly ignoredHeadSha: string | null;
      // Events that arrived before this session claimed the PR and were replayed to it.
      readonly backfilled: number;
    }
  | { readonly ok: false; readonly reason: 'conflict'; readonly existing: SessionRoute };

export type DeregisterResult = 'deregistered' | 'not_registered' | 'session_mismatch';

export type Classification =
  | { readonly routed: false; readonly reason: UnroutedReason; readonly route: SessionRoute | null }
  | {
      readonly routed: true;
      readonly route: SessionRoute;
      readonly stale: boolean;
      readonly headKnown: boolean;
      readonly suppressedPositiveSignal: boolean;
    };

export interface ApplyResult {
  readonly headAdvanced: boolean;
  readonly lifecycle: RouteLifecycleState | null;
  readonly closed: boolean;
}

export interface RouteInput {
  readonly deliveryId: string;
  readonly receivedAtIso?: string;
}

export type RouteOutcome =
  | {
      readonly outcome: 'enqueued';
      readonly envelope: EventEnvelope;
      readonly stale: boolean;
      readonly suppressedPositiveSignal: boolean;
      readonly applied: ApplyResult;
    }
  | { readonly outcome: 'unrouted'; readonly reason: UnroutedReason };

export interface PrRegistryOptions {
  readonly now?: () => Date;
}

export class PrRegistry {
  readonly #db: ChannelDb;
  readonly #now: () => Date;

  constructor(db: ChannelDb, options: PrRegistryOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date());
  }

  register(input: RegisterInput): RegisterResult {
    const prRef = canonical(input.prRef);
    return this.#db.transaction(() => {
      const existing = this.#db.getRoute(prRef);
      const held = existing !== null && !existing.closed && existing.sessionId !== input.sessionId;
      if (held && !input.replace) return { ok: false, reason: 'conflict', existing };
      const reopening = existing !== null && existing.closed;
      const head = this.#acceptRegistrationHead(existing, input.headSha ?? null, input.replace === true);
      const now = this.#nowIso();
      const route = this.#db.upsertRoute({
        prRef,
        sessionId: input.sessionId,
        headSha: head.accepted,
        headSource: 'registration',
        workerDir: input.workerDir ?? null,
        // When this head was asserted, for the route to report. It orders nothing: a
        // `pull_request` delivery outranks a registration head whatever the clocks say.
        headEventAtIso: now,
        // A row kept after close/merge still says closed/merged; a new registration
        // starts a fresh open route unless the caller states otherwise.
        lifecycle: input.lifecycle ?? (reopening ? 'open' : undefined),
        nowIso: now,
      });
      const backfilled = this.#backfill(route, now);
      return {
        ok: true,
        route,
        replaced: held ? existing : null,
        ignoredHeadSha: head.ignored,
        backfilled,
      };
    });
  }

  // A worker almost always joins a PR that already has CI results, comments and reviews.
  // Those arrived with no route and were parked as unrouted; replaying them here is what
  // stops a session being blind to the state it just joined. Events for a superseded head
  // are handed over flagged stale, so they read as history rather than a signal.
  #backfill(route: SessionRoute, nowIso_: string): number {
    const claimed = this.#db.claimUnrouted(route.prRef, nowIso_);
    let enqueued = 0;
    for (const item of claimed) {
      const headSha = item.payload.headSha;
      const stale = headSha !== null && route.headSha !== null && headSha !== route.headSha;
      const ok = this.#db.enqueueEvent({
        id: newEventId(),
        deliveryId: item.deliveryId,
        prRef: route.prRef,
        sessionId: route.sessionId,
        receivedAtIso: item.receivedAtIso,
        headSha,
        stale,
        kind: item.payload.kind,
        payload: item.payload,
      } as EventEnvelope);
      if (ok) enqueued += 1;
    }
    return enqueued;
  }

  // Registration asserts a head from a local clone that may be behind GitHub. It may seed
  // a head and correct its own earlier assertion, but it must never overrule one a webhook
  // established. Re-asserting the head already in force is a no-op, not a re-seed: writing
  // it back would relabel a webhook-learned head as merely registration-asserted.
  #acceptRegistrationHead(
    existing: SessionRoute | null,
    requested: string | null,
    replace: boolean,
  ): { accepted: string | null; ignored: string | null } {
    if (requested === null) return { accepted: null, ignored: null };
    if (existing === null || existing.closed || existing.headSha === null) {
      return { accepted: requested, ignored: null };
    }
    if (existing.headSha === requested) return { accepted: null, ignored: null };
    if (replace) return { accepted: requested, ignored: null };
    if (existing.headSource === 'lifecycle') return { accepted: null, ignored: requested };
    return { accepted: requested, ignored: null };
  }

  deregister(prRef: PrRef, sessionId: string): DeregisterResult {
    const ref = canonical(prRef);
    return this.#db.transaction(() => {
      const existing = this.#db.getRoute(ref);
      if (!existing) return 'not_registered';
      if (existing.sessionId !== sessionId) return 'session_mismatch';
      this.#db.deleteRoute(ref);
      return 'deregistered';
    });
  }

  getRoute(prRef: PrRef): SessionRoute | null {
    return this.#db.getRoute(canonical(prRef));
  }

  getRouteBySession(sessionId: string): SessionRoute | null {
    return this.#db.getRouteBySession(sessionId);
  }

  listOpenRoutes(): SessionRoute[] {
    return this.#db.listOpenRoutes();
  }

  currentHead(prRef: PrRef): string | null {
    return this.#db.findOpenRoute(canonical(prRef))?.headSha ?? null;
  }

  // The operator-driven correction, and the only head move that answers to nobody: it is
  // how a route whose head drifted is put back on the sha the PR actually has.
  advanceHead(prRef: PrRef, headSha: string): boolean {
    const ref = canonical(prRef);
    return this.#db.transaction(() => {
      const route = this.#db.findOpenRoute(ref);
      if (!route || route.headSha === headSha) return false;
      const now = this.#nowIso();
      return this.#db.setHeadSha(ref, headSha, { eventAtIso: now, nowIso: now });
    });
  }

  findOpenPrsByHead(repo: string, headSha: string): readonly PrRef[] {
    const wanted = normalizeRepo(repo);
    return this.#db
      .listOpenRoutes()
      .filter((route) => route.prRef.repo === wanted && route.headSha === headSha)
      .map((route) => route.prRef);
  }

  // For a delivery that names no PR, only its head sha identifies it. Matching the
  // current head is not enough: a check can outrun the synchronize for its own head, and
  // a route that has closed still owes its events an unrouted record rather than
  // silence, so every head a route has ever held counts.
  findPrsByHead(repo: string, headSha: string): readonly PrRef[] {
    const wanted = normalizeRepo(repo);
    const refs = [...this.findOpenPrsByHead(wanted, headSha)];
    for (const ref of this.#db.findPrsBySeenHead(wanted, headSha)) {
      if (!refs.some((seen) => seen.prNumber === ref.prNumber)) refs.push(ref);
    }
    return refs;
  }

  closeRoute(prRef: PrRef, options: { lifecycle: 'closed' | 'merged'; sessionId?: string }): boolean {
    return this.#db.closeRoute(canonical(prRef), {
      lifecycle: options.lifecycle,
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      nowIso: this.#nowIso(),
    });
  }

  classify(event: PrEvent): Classification {
    const ref = canonical(event.prRef);
    const route = this.#db.getRoute(ref);
    if (!route) return { routed: false, reason: 'no_route', route: null };
    if (route.closed) return { routed: false, reason: 'route_closed', route };
    // Lifecycle events define the head rather than report on it, so they are never stale.
    const headKnown = route.headSha !== null;
    const stale =
      event.kind !== 'pr_lifecycle' && headKnown && event.headSha !== null && event.headSha !== route.headSha;
    return {
      routed: true,
      route,
      stale,
      headKnown,
      // With no head on record the event cannot be vouched for as being about the
      // current head, so a green for it is not a green light either.
      suppressedPositiveSignal: (stale || !headKnown) && isPositiveHeadSignal(event),
    };
  }

  apply(event: PrEvent): ApplyResult {
    if (event.kind !== 'pr_lifecycle') return { headAdvanced: false, lifecycle: null, closed: false };
    return this.#db.transaction(() => this.#applyLifecycle(event));
  }

  // Classify, enqueue (or record as unrouted), then apply lifecycle side effects, all in
  // one transaction. Ordering matters: the terminal envelope is enqueued before the route
  // closes, and a synchronize event is enqueued before the head advances.
  route(event: PrEvent, input: RouteInput): RouteOutcome {
    const receivedAtIso = input.receivedAtIso ?? this.#nowIso();
    const ref = canonical(event.prRef);
    return this.#db.transaction(() => {
      const classification = this.classify(event);
      if (!classification.routed) {
        this.#db.recordUnrouted({
          deliveryId: input.deliveryId,
          prRef: ref,
          receivedAtIso,
          reason: classification.reason,
          payload: event,
        });
        return { outcome: 'unrouted', reason: classification.reason };
      }
      const envelope = {
        id: newEventId(),
        deliveryId: input.deliveryId,
        prRef: ref,
        sessionId: classification.route.sessionId,
        receivedAtIso,
        headSha: event.headSha,
        stale: classification.stale,
        kind: event.kind,
        payload: event,
      } as EventEnvelope;
      this.#db.enqueueEvent(envelope, this.#now().getTime());
      const applied = event.kind === 'pr_lifecycle' ? this.#applyLifecycle(event) : NO_CHANGE;
      return {
        outcome: 'enqueued',
        envelope,
        stale: classification.stale,
        suppressedPositiveSignal: classification.suppressedPositiveSignal,
        applied,
      };
    });
  }

  #applyLifecycle(event: PrLifecycleEvent): ApplyResult {
    const ref = canonical(event.prRef);
    const route = this.#db.findOpenRoute(ref);
    if (!route) return NO_CHANGE;
    const now = this.#nowIso();
    if (isTerminalLifecycleAction(event.action)) {
      const closed = this.#db.closeRoute(ref, { lifecycle: event.action, nowIso: now });
      return { headAdvanced: false, lifecycle: event.action, closed };
    }
    const lifecycle = lifecycleStateAfter(event.action, event.draft);
    const incomingHead = event.headSha;
    const headAdvanced =
      incomingHead !== null &&
      this.#advancesHead(ref, route, event) &&
      this.#db.setHeadSha(ref, incomingHead, {
        source: 'lifecycle',
        eventAtIso: event.occurredAtIso,
        nowIso: now,
      });
    if (lifecycle !== route.lifecycle) this.#db.setLifecycle(ref, lifecycle, now);
    return { headAdvanced, lifecycle, closed: false };
  }

  // Source outranks time: a registration head is a clone's guess stamped with a local
  // clock, and a clone one push behind would otherwise pin the route to a commit the PR
  // left, with that commit's checks reading as the current head being green.
  // Between two lifecycle deliveries time decides, since GitHub orders nothing: only one
  // newer than the event that put the head in force may move it. A sha the PR already left
  // may become the head again -- that is what a force-push back to it looks like on the
  // wire -- so the heads seen so far only break a tie between deliveries sharing an instant.
  #advancesHead(prRef: PrRef, route: SessionRoute, event: PrLifecycleEvent): boolean {
    if (event.headSha === null || event.headSha === route.headSha) return false;
    if (route.headSha === null || route.headEventAtIso === null) return true;
    if (route.headSource !== 'lifecycle') return true;
    const inForce = Date.parse(route.headEventAtIso);
    const incoming = Date.parse(event.occurredAtIso);
    if (Number.isNaN(inForce) || Number.isNaN(incoming) || incoming === inForce) {
      return !this.#db.hasSeenHead(prRef, event.headSha);
    }
    return incoming > inForce;
  }

  #nowIso(): string {
    return this.#now().toISOString();
  }
}

const NO_CHANGE: ApplyResult = { headAdvanced: false, lifecycle: null, closed: false };

function canonical(prRef: PrRef): PrRef {
  return { repo: normalizeRepo(prRef.repo), prNumber: prRef.prNumber };
}
