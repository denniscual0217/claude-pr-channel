import type { ChannelDb } from '../store/db.js';
import type { EventEnvelope, PrRef } from '../types.js';
import { isPositiveHeadSignal } from '../types.js';

export interface DeliveredEvent {
  readonly id: string;
  readonly deliveryId: string;
  readonly kind: string;
  readonly prRef: PrRef;
  readonly headSha: string | null;
  readonly currentHeadSha: string | null;
  readonly stale: boolean;
  readonly headConfirmed: boolean;
  // A green or Temploy-ready event for a head that is no longer current. It is still
  // delivered, as history, but it must never read as a signal about the current head.
  readonly positiveSignalSuppressed: boolean;
  readonly receivedAtIso: string;
  readonly payload: EventEnvelope['payload'];
}

// Staleness is decided against the head the route holds now, not the one recorded when
// the event was queued: a head can advance between queueing and delivery.
export function describeEvent(envelope: EventEnvelope, currentHeadSha: string | null): DeliveredEvent {
  const comparable = envelope.kind !== 'pr_lifecycle' && envelope.headSha !== null;
  const stale =
    currentHeadSha === null ? envelope.stale : comparable && envelope.headSha !== currentHeadSha;
  const headConfirmed = comparable ? envelope.headSha === currentHeadSha : true;
  return {
    id: envelope.id,
    deliveryId: envelope.deliveryId,
    kind: envelope.kind,
    prRef: envelope.prRef,
    headSha: envelope.headSha,
    currentHeadSha,
    stale,
    headConfirmed,
    positiveSignalSuppressed: !headConfirmed && isPositiveHeadSignal(envelope.payload),
    receivedAtIso: envelope.receivedAtIso,
    payload: envelope.payload,
  };
}

export function routeHeadSha(db: ChannelDb, prRef: PrRef): string | null {
  return db.getRoute(prRef)?.headSha ?? null;
}
