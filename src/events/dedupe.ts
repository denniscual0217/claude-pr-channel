import { createHash } from 'node:crypto';
import type { ChannelDb } from '../store/db.js';
import type { PrEvent } from '../types.js';
import { prKey } from '../types.js';

export interface DeliveryInput {
  readonly deliveryId: string | undefined;
  readonly eventName: string;
  readonly repo: string | null;
  readonly receivedAtIso?: string;
}

export type DedupeVerdict =
  | { readonly accepted: true; readonly deliveryId: string }
  | { readonly accepted: false; readonly reason: 'replayed_delivery'; readonly deliveryId: string }
  | { readonly accepted: false; readonly reason: 'missing_delivery_id' };

export interface LogicalDuplicate {
  readonly fingerprint: string;
  readonly previousDeliveryId: string;
}

export interface DeliveryDeduperOptions {
  readonly logicalWindow?: number;
}

// Two layers, deliberately different in strength:
//
// 1. Delivery IDs (X-GitHub-Delivery) are the durable, atomic layer. recordDeliveryOnce
//    is a single INSERT OR IGNORE on a UNIQUE column, so concurrent identical deliveries
//    across connections or processes collapse to exactly one acceptance.
//
// 2. GitHub can also send the same logical state under fresh IDs (a check run reported
//    twice, a comment edit that changed nothing, a redelivery from the UI). These are
//    NOT dropped: a fresh ID may equally be a genuine repeat (a rerequested check that
//    completed with the same result), and the queue is at-least-once with idempotent
//    acks anyway. Instead the event's fingerprint is remembered in a bounded in-memory
//    window and the earlier delivery ID is reported, so the dispatcher can log it and
//    the consumer can collapse it. Best effort only; it does not survive a restart.
export class DeliveryDeduper {
  readonly #db: ChannelDb;
  readonly #seenFingerprints = new Map<string, string>();
  readonly #logicalWindow: number;

  constructor(db: ChannelDb, options: DeliveryDeduperOptions = {}) {
    this.#db = db;
    this.#logicalWindow = options.logicalWindow ?? 5_000;
  }

  accept(input: DeliveryInput): DedupeVerdict {
    const deliveryId = input.deliveryId?.trim() ?? '';
    if (deliveryId.length === 0) return { accepted: false, reason: 'missing_delivery_id' };
    const fresh = this.#db.recordDeliveryOnce({
      deliveryId,
      eventName: input.eventName,
      repo: input.repo,
      ...(input.receivedAtIso !== undefined ? { receivedAtIso: input.receivedAtIso } : {}),
    });
    return fresh ? { accepted: true, deliveryId } : { accepted: false, reason: 'replayed_delivery', deliveryId };
  }

  noteLogicalState(event: PrEvent, deliveryId: string): LogicalDuplicate | null {
    const fingerprint = logicalFingerprint(event);
    const previousDeliveryId = this.#seenFingerprints.get(fingerprint);
    if (previousDeliveryId !== undefined) {
      this.#seenFingerprints.delete(fingerprint);
      this.#seenFingerprints.set(fingerprint, previousDeliveryId);
      return previousDeliveryId === deliveryId ? null : { fingerprint, previousDeliveryId };
    }
    this.#seenFingerprints.set(fingerprint, deliveryId);
    while (this.#seenFingerprints.size > this.#logicalWindow) {
      const oldest = this.#seenFingerprints.keys().next().value;
      if (oldest === undefined) break;
      this.#seenFingerprints.delete(oldest);
    }
    return null;
  }
}

export function logicalFingerprint(event: PrEvent): string {
  const parts: (string | number | null)[] = [event.kind, prKey(event.prRef)];
  switch (event.kind) {
    case 'pr_comment':
      parts.push(event.action, event.commentId, digest(event.untrustedBody.text));
      break;
    case 'pr_review':
      parts.push(event.action, event.reviewId, event.reviewState, digest(event.untrustedBody.text));
      break;
    case 'pr_review_comment':
      parts.push(event.action, event.commentId, digest(event.untrustedBody.text));
      break;
    case 'ci_check':
      parts.push(event.headSha, event.checkName, event.checkRunId, stateTag(event.state));
      break;
    case 'ci_all_required_green':
      parts.push(event.headSha, [...event.checkNames].sort().join(','));
      break;
    case 'temploy_workflow':
      parts.push(event.headSha, event.workflowRunId, event.runAttempt, stateTag(event.state));
      break;
    case 'pr_lifecycle':
      parts.push(event.action, event.headSha, event.draft ? 'draft' : 'ready', digest(event.untrustedTitle.text));
      break;
  }
  return parts.map((part) => (part === null ? '-' : String(part))).join('|');
}

function stateTag(state: { status: string; conclusion?: string }): string {
  return state.status === 'completed' ? `completed:${state.conclusion ?? ''}` : state.status;
}

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}
