import type { CheckState, EventEnvelope, TemployWorkflowState } from '../types.js';
import { isGreen } from '../types.js';

// Which CI events are worth interrupting a session for.
//   completed every finished check, successes included (default)
//   failures  only checks that finished badly, plus the derived all-required-green
//   all       every transition, including queued and in_progress
export type CiEvents = 'failures' | 'completed' | 'all';

const NEEDS_ATTENTION = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);

export function finishedBadly(state: CheckState | TemployWorkflowState): boolean {
  return state.status === 'completed' && NEEDS_ATTENTION.has(state.conclusion);
}

// A push with twenty checks fires sixty of these, and "ci/lint is queued" is not worth a
// turn of the session's attention. Suppressed events are counted, they just do not
// interrupt.
export function worthWaking(envelope: EventEnvelope, ciEvents: CiEvents): boolean {
  const event = envelope.payload;
  if (event.kind === 'ci_check') {
    if (ciEvents === 'all') return true;
    if (ciEvents === 'completed') return event.state.status === 'completed';
    return finishedBadly(event.state);
  }
  // Only a successful image is worth a turn: it is the signal that follow-on work
  // depending on the deployed image can start. A Temploy build failure is not this
  // session's to chase, so it never interrupts.
  if (event.kind === 'temploy_workflow') {
    return ciEvents === 'all' || isGreen(event.state);
  }
  return true;
}
