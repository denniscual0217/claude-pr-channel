import type {
  HeadSource,
  PrEvent,
  PrLifecycleEvent,
  PrRef,
  RouteLifecycleState,
  TerminalLifecycleAction,
} from '../types.js';
import { isPositiveHeadSignal, isTerminalLifecycleAction, lifecycleStateAfter } from '../types.js';
import { normalizeRepo } from './repo.js';

export interface Classification {
  readonly stale: boolean;
  readonly headKnown: boolean;
  readonly suppressedPositiveSignal: boolean;
}

export interface ApplyResult {
  readonly headAdvanced: boolean;
  readonly lifecycle: RouteLifecycleState | null;
  readonly closed: boolean;
  readonly terminal: TerminalLifecycleAction | null;
}

const NO_CHANGE: ApplyResult = { headAdvanced: false, lifecycle: null, closed: false, terminal: null };

// The registry's head logic, minus the database: one PR, held in memory for as long as
// the session tracks it.
export class HeadTracker {
  readonly prRef: PrRef;
  #headSha: string | null = null;
  #headSource: HeadSource | null = null;
  #headEventAtIso: string | null = null;
  #lifecycle: RouteLifecycleState = 'open';
  #closed = false;
  #lastAction: string | null = null;
  readonly #seenHeads = new Set<string>();

  constructor(prRef: PrRef, lifecycle: RouteLifecycleState = 'open') {
    this.prRef = { repo: normalizeRepo(prRef.repo), prNumber: prRef.prNumber };
    this.#lifecycle = lifecycle;
  }

  get headSha(): string | null {
    return this.#headSha;
  }

  get headSource(): HeadSource | null {
    return this.#headSource;
  }

  get headEventAtIso(): string | null {
    return this.#headEventAtIso;
  }

  get lifecycle(): RouteLifecycleState {
    return this.#lifecycle;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get lastLifecycleAction(): string | null {
    return this.#lastAction;
  }

  get seenHeads(): readonly string[] {
    return [...this.#seenHeads];
  }

  // Seeding asserts a head from a local `gh pr view` that may be behind GitHub. It may
  // correct its own earlier assertion, but never one a lifecycle delivery established.
  // Re-seeding the head already in force is a no-op: writing it back would relabel a
  // webhook-learned head as merely registration-asserted.
  seed(headSha: string | null, atIso: string = new Date().toISOString()): { accepted: string | null; ignored: string | null } {
    if (headSha === null) return { accepted: null, ignored: null };
    if (this.#headSha === null) return this.#setHead(headSha, 'registration', atIso);
    if (this.#headSha === headSha) return { accepted: null, ignored: null };
    if (this.#headSource === 'lifecycle') return { accepted: null, ignored: headSha };
    return this.#setHead(headSha, 'registration', atIso);
  }

  classify(event: PrEvent): Classification {
    const headKnown = this.#headSha !== null;
    // Lifecycle events define the head rather than report on it, so they are never stale.
    const stale =
      event.kind !== 'pr_lifecycle' && headKnown && event.headSha !== null && event.headSha !== this.#headSha;
    return {
      stale,
      headKnown,
      // With no head on record the event cannot be vouched for as being about the
      // current head, so a green for it is not a green light either.
      suppressedPositiveSignal: (stale || !headKnown) && isPositiveHeadSignal(event),
    };
  }

  apply(event: PrEvent): ApplyResult {
    if (event.kind !== 'pr_lifecycle') return NO_CHANGE;
    return this.#applyLifecycle(event);
  }

  prsByHead(repo: string, headSha: string): readonly PrRef[] {
    if (normalizeRepo(repo) !== this.prRef.repo) return [];
    if (headSha === this.#headSha || this.#seenHeads.has(headSha)) return [this.prRef];
    return [];
  }

  #applyLifecycle(event: PrLifecycleEvent): ApplyResult {
    this.#lastAction = event.action;
    if (isTerminalLifecycleAction(event.action)) {
      const alreadyClosed = this.#closed;
      this.#closed = true;
      this.#lifecycle = event.action;
      return { headAdvanced: false, lifecycle: event.action, closed: !alreadyClosed, terminal: event.action };
    }
    if (this.#closed) return NO_CHANGE;
    const lifecycle = lifecycleStateAfter(event.action, event.draft);
    const headAdvanced =
      event.headSha !== null && this.#advancesHead(event) && this.#setHead(event.headSha, 'lifecycle', event.occurredAtIso).accepted !== null;
    this.#lifecycle = lifecycle;
    return { headAdvanced, lifecycle, closed: false, terminal: null };
  }

  // Source outranks time: a registration head is a clone's guess stamped with a local
  // clock, and a clone one push behind would otherwise pin tracking to a commit the PR
  // left, with that commit's checks reading as the current head being green.
  // Between two lifecycle deliveries time decides, since GitHub orders nothing: only one
  // newer than the event that put the head in force may move it. A sha the PR already
  // left may become the head again -- that is what a force-push back to it looks like on
  // the wire -- so the heads seen so far only break a tie between deliveries sharing an
  // instant.
  #advancesHead(event: PrLifecycleEvent): boolean {
    if (event.headSha === null || event.headSha === this.#headSha) return false;
    if (this.#headSha === null || this.#headEventAtIso === null) return true;
    if (this.#headSource !== 'lifecycle') return true;
    const inForce = Date.parse(this.#headEventAtIso);
    const incoming = Date.parse(event.occurredAtIso);
    if (Number.isNaN(inForce) || Number.isNaN(incoming) || incoming === inForce) {
      return !this.#seenHeads.has(event.headSha);
    }
    return incoming > inForce;
  }

  #setHead(headSha: string, source: HeadSource, atIso: string): { accepted: string; ignored: null } {
    this.#headSha = headSha;
    this.#headSource = source;
    this.#headEventAtIso = atIso;
    this.#seenHeads.add(headSha);
    return { accepted: headSha, ignored: null };
  }
}
