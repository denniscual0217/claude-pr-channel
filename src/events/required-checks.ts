import type { ChannelDb } from '../store/db.js';
import type { CheckState, CiAllRequiredGreenEvent, PrEvent, PrRef } from '../types.js';
import { isGreen } from '../types.js';

export interface RequiredChecksTrackerOptions {
  readonly maxTrackedHeadsPerPr?: number;
}

// GitHub never says which checks a branch rule requires, so "all required green" is
// derived from the configured list and the check states seen per (PR, head). Those states
// and the announcement live in SQLite because the contract promises the derived event
// unconditionally: a dispatcher that restarts halfway through a CI run must still complete
// the set from the greens already banked, which no amount of process memory survives.
export class RequiredChecksTracker {
  readonly #db: ChannelDb;
  readonly #required: readonly string[];
  readonly #signature: string;
  readonly #maxTrackedHeadsPerPr: number;

  constructor(db: ChannelDb, requiredChecks: Iterable<string>, options: RequiredChecksTrackerOptions = {}) {
    this.#db = db;
    this.#required = [...new Set([...requiredChecks].map((name) => name.trim()).filter((name) => name.length > 0))];
    this.#signature = [...this.#required].sort().join('\n');
    this.#maxTrackedHeadsPerPr = options.maxTrackedHeadsPerPr ?? 100;
  }

  get requiredChecks(): readonly string[] {
    return this.#required;
  }

  // currentHeadSha is the head the registry holds after this event was applied. A check
  // can arrive before the lifecycle delivery that makes its head current, so a head
  // becoming current is a second chance to derive the green for it.
  observe(event: PrEvent, currentHeadSha: string | null): CiAllRequiredGreenEvent | null {
    if (event.kind === 'pr_lifecycle') {
      return currentHeadSha === null ? null : this.#derive(event.prRef, currentHeadSha, event, currentHeadSha);
    }
    if (event.kind !== 'ci_check') return null;
    this.#db.recordCheckState(event.prRef, event.headSha, event.checkName, event.state, event.occurredAtIso);
    this.#db.pruneCheckHeads(event.prRef, this.#maxTrackedHeadsPerPr);
    return this.#derive(event.prRef, event.headSha, event, currentHeadSha);
  }

  states(prRef: PrRef, headSha: string): ReadonlyMap<string, CheckState> {
    return this.#db.checkStates(prRef, headSha);
  }

  forget(prRef: PrRef): void {
    this.#db.forgetCheckStates(prRef);
  }

  #derive(
    prRef: PrRef,
    headSha: string,
    source: PrEvent,
    currentHeadSha: string | null,
  ): CiAllRequiredGreenEvent | null {
    if (this.#required.length === 0) return null;
    const states = this.#db.checkStates(prRef, headSha);
    const announced = this.#db.announcedChecks(prRef, headSha);
    const allGreen = this.#required.every((name) => {
      const state = states.get(name);
      return state !== undefined && isGreen(state);
    });
    if (!allGreen) {
      if (announced !== null) this.#db.setAnnouncedChecks(prRef, headSha, null);
      return null;
    }
    // A green for a head that is not the current one reaches the session suppressed --
    // history, never a green light -- so it does not spend the once-per-head
    // announcement. The head becoming current is when that announcement is really owed.
    const headConfirmed = headSha === currentHeadSha;
    if (announced?.signature === this.#signature) {
      if (announced.headConfirmed || !headConfirmed) return null;
      // A copy the session has not been handed yet is the announcement: poll time
      // re-evaluates staleness against the head known then, so it arrives confirmed. One
      // already delivered cannot be corrected -- the session handles it as it stands and
      // acks it -- so the announcement is still owed, duplicate or not.
      if (this.#db.hasUndeliveredEventForHead(prRef, headSha, 'ci_all_required_green')) {
        this.#db.setAnnouncedChecks(prRef, headSha, { signature: this.#signature, headConfirmed: true });
        return null;
      }
    }
    this.#db.setAnnouncedChecks(prRef, headSha, { signature: this.#signature, headConfirmed });
    return {
      kind: 'ci_all_required_green',
      prRef,
      headSha,
      actorLogin: source.actorLogin,
      occurredAtIso: source.occurredAtIso,
      htmlUrl: null,
      checkNames: [...this.#required],
    };
  }
}
