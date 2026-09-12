import type { CheckState, EventEnvelope, PrLifecycleAction, WorkflowRunState } from '../types.js';
import { isGreen } from '../types.js';

// Which CI events are worth interrupting a session for.
//   completed every finished check, successes included (default)
//   failures  only checks that finished badly, plus the derived all-required-green
//   all       every transition, including queued and in_progress
export type CiEvents = 'failures' | 'completed' | 'all';

// What this session has been told to wake for, resolved once per track from the config
// file and the track arguments.
export interface DeliveryPolicy {
  readonly comments: boolean;
  readonly reviews: boolean;
  readonly reviewComments: boolean;
  readonly checks: { readonly enabled: boolean; readonly wake: CiEvents };
  readonly requiredChecks: { readonly enabled: boolean };
  readonly deployWorkflow: { readonly enabled: boolean };
  readonly lifecycle: Readonly<Record<PrLifecycleAction, boolean>>;
}

const NEEDS_ATTENTION = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);

export function finishedBadly(state: CheckState | WorkflowRunState): boolean {
  return state.status === 'completed' && NEEDS_ATTENTION.has(state.conclusion);
}

// The last gate before a session is interrupted, and deliberately the last: everything
// upstream — normalization, head tracking, the derived all-required-green, terminal
// detection — has already run, so turning a kind off makes the session silent about it,
// not blind to it. A push with twenty checks fires sixty transitions, and "ci/lint is
// queued" is not worth a turn. Suppressed events are counted, they just do not interrupt.
export function worthWaking(envelope: EventEnvelope, policy: DeliveryPolicy): boolean {
  const event = envelope.payload;
  switch (event.kind) {
    case 'pr_comment':
      return policy.comments;
    case 'pr_review':
      return policy.reviews;
    case 'pr_review_comment':
      return policy.reviewComments;
    case 'ci_check':
      if (!policy.checks.enabled) return false;
      if (policy.checks.wake === 'all') return true;
      if (policy.checks.wake === 'completed') return event.state.status === 'completed';
      return finishedBadly(event.state);
    case 'ci_all_required_green':
      return policy.requiredChecks.enabled;
    // Only a successful run is worth a turn: it is the signal that work depending on what
    // the workflow builds can start. A failed build of the deploy workflow is not this
    // session's to chase and a queued one says nothing yet, so neither ever interrupts —
    // checks.wake is about CI checks and does not widen this.
    case 'deploy_workflow':
      return policy.deployWorkflow.enabled && isGreen(event.state);
    case 'pr_lifecycle':
      return policy.lifecycle[event.action];
  }
}
