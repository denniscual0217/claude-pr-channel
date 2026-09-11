import type { CheckState, CiAllRequiredGreenEvent, PrEvent } from '../types.js';
import { isGreen } from '../types.js';

export interface RequiredChecksTrackerOptions {
  readonly maxTrackedHeads?: number;
}

interface AnnouncedGreen {
  readonly signature: string;
  readonly headConfirmed: boolean;
}

interface HeadRecord {
  readonly states: Map<string, { state: CheckState; observedAtIso: string }>;
  announced: AnnouncedGreen | null;
}

// GitHub never says which checks a branch rule requires, so "all required green" is
// derived from the configured list and the check states seen per head. One session
// tracks one PR for as long as it runs, so the states live in memory: there is no
// restart to survive, and tracking that stopped has nothing left to derive.
export class RequiredChecksTracker {
  readonly #required: readonly string[];
  readonly #signature: string;
  readonly #maxTrackedHeads: number;
  readonly #heads = new Map<string, HeadRecord>();

  constructor(requiredChecks: Iterable<string>, options: RequiredChecksTrackerOptions = {}) {
    this.#required = [...new Set([...requiredChecks].map((name) => name.trim()).filter((name) => name.length > 0))];
    this.#signature = [...this.#required].sort().join('\n');
    this.#maxTrackedHeads = options.maxTrackedHeads ?? 100;
  }

  get requiredChecks(): readonly string[] {
    return this.#required;
  }

  // currentHeadSha is the head held after this event was applied. A check can arrive
  // before the lifecycle delivery that makes its head current, so a head becoming current
  // is a second chance to derive the green for it.
  observe(event: PrEvent, currentHeadSha: string | null): CiAllRequiredGreenEvent | null {
    if (event.kind === 'pr_lifecycle') {
      return currentHeadSha === null ? null : this.#derive(currentHeadSha, event, currentHeadSha);
    }
    if (event.kind !== 'ci_check') return null;
    this.#record(event.headSha, event.checkName, event.state, event.occurredAtIso);
    return this.#derive(event.headSha, event, currentHeadSha);
  }

  states(headSha: string): ReadonlyMap<string, CheckState> {
    const record = this.#heads.get(headSha);
    const states = new Map<string, CheckState>();
    if (!record) return states;
    for (const [name, entry] of record.states) states.set(name, entry.state);
    return states;
  }

  forget(): void {
    this.#heads.clear();
  }

  #record(headSha: string, checkName: string, state: CheckState, observedAtIso: string): void {
    const record = this.#head(headSha);
    const previous = record.states.get(checkName);
    // Newer wins. GitHub can redeliver an older success after a newer failure; taking the
    // last writer would turn a red head green.
    if (previous !== undefined && !supersedes(observedAtIso, previous.observedAtIso)) return;
    record.states.set(checkName, { state, observedAtIso });
  }

  #head(headSha: string): HeadRecord {
    let record = this.#heads.get(headSha);
    if (record === undefined) {
      record = { states: new Map(), announced: null };
      this.#heads.set(headSha, record);
    }
    // Bounds what one long-lived PR can accumulate, oldest head first.
    while (this.#heads.size > this.#maxTrackedHeads) {
      const oldest = this.#heads.keys().next().value;
      if (oldest === undefined || oldest === headSha) break;
      this.#heads.delete(oldest);
    }
    return record;
  }

  #derive(headSha: string, source: PrEvent, currentHeadSha: string | null): CiAllRequiredGreenEvent | null {
    if (this.#required.length === 0) return null;
    const record = this.#heads.get(headSha);
    const states = record?.states;
    const allGreen =
      states !== undefined &&
      this.#required.every((name) => {
        const entry = states.get(name);
        return entry !== undefined && isGreen(entry.state);
      });
    if (!allGreen) {
      if (record?.announced != null) record.announced = null;
      return null;
    }
    // A green for a head that is not the current one reaches the session suppressed --
    // history, never a green light -- so it does not spend the once-per-head
    // announcement. The head becoming current is when that announcement is really owed.
    const headConfirmed = headSha === currentHeadSha;
    const announced = (record as HeadRecord).announced;
    if (announced?.signature === this.#signature && (announced.headConfirmed || !headConfirmed)) return null;
    (record as HeadRecord).announced = { signature: this.#signature, headConfirmed };
    return {
      kind: 'ci_all_required_green',
      prRef: source.prRef,
      headSha,
      actorLogin: source.actorLogin,
      occurredAtIso: source.occurredAtIso,
      htmlUrl: null,
      checkNames: [...this.#required],
    };
  }
}

function supersedes(incomingAtIso: string, storedAtIso: string): boolean {
  const incoming = Date.parse(incomingAtIso);
  const stored = Date.parse(storedAtIso);
  if (Number.isNaN(incoming) || Number.isNaN(stored)) return true;
  return incoming >= stored;
}
