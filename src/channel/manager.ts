import { resolve } from 'node:path';
import { ConfigError, DEFAULTS, ENV } from '../config.js';
import type { ChannelDb, QueueStats } from '../store/db.js';
import type { EnvelopeOf, PrRef, RouteLifecycleState, SessionRoute, UnroutedReason } from '../types.js';
import { isTerminalLifecycleAction } from '../types.js';

export type ChannelState = 'unregistered' | 'active' | 'closed';

export interface ChannelStatus {
  readonly sessionId: string;
  readonly state: ChannelState;
  readonly route: SessionRoute | null;
  readonly queue: QueueStats;
  readonly unacked: number;
  readonly drained: boolean;
}

export interface RegisterInput {
  readonly prRef: PrRef;
  readonly sessionId: string;
  readonly headSha?: string | null;
  readonly lifecycle?: RouteLifecycleState;
  readonly nowIso?: string;
}

export type TerminalDeliveryResult =
  | { readonly delivered: true; readonly closed: true }
  | { readonly delivered: false; readonly reason: UnroutedReason };

export interface DrainWatchOptions {
  readonly intervalMs: number;
  readonly onDrained: () => void;
}

const REPO_PATTERN = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

// Lifecycle only. Closing a channel means the route stops accepting events and the
// channel process exits once its queue is drained; the worker's terminal session is
// never signalled or touched.
export class ChannelManager {
  readonly #db: ChannelDb;

  constructor(db: ChannelDb) {
    this.#db = db;
  }

  register(input: RegisterInput): SessionRoute {
    assertSessionId(input.sessionId);
    assertPrRef(input.prRef);
    return this.#db.upsertRoute(input);
  }

  deregister(prRef: PrRef, sessionId: string, nowIso?: string): boolean {
    assertSessionId(sessionId);
    return this.#db.closeRoute(prRef, { sessionId, nowIso });
  }

  // The terminal event is enqueued before the route closes, inside one transaction,
  // so a channel can never observe "closed" without the event that explains why.
  deliverTerminalAndClose(envelope: EnvelopeOf<'pr_lifecycle'>, now: number = Date.now()): TerminalDeliveryResult {
    const { action } = envelope.payload;
    if (!isTerminalLifecycleAction(action)) {
      throw new TypeError(`pr_lifecycle action "${action}" is not terminal`);
    }
    return this.#db.transaction(() => {
      const route = this.#db.getRoute(envelope.prRef);
      if (!route) return { delivered: false, reason: 'no_route' };
      if (route.closed) return { delivered: false, reason: 'route_closed' };
      if (route.sessionId !== envelope.sessionId) return { delivered: false, reason: 'session_mismatch' };

      this.#db.enqueueEvent(envelope, now);
      const closed = this.#db.closeRoute(envelope.prRef, {
        lifecycle: action,
        sessionId: envelope.sessionId,
        nowIso: new Date(now).toISOString(),
      });
      if (!closed) throw new Error(`route ${envelope.prRef.repo}#${envelope.prRef.prNumber} changed mid-transaction`);
      return { delivered: true, closed: true };
    });
  }

  status(sessionId: string, now: number = Date.now()): ChannelStatus {
    const route = this.#db.getRouteBySession(sessionId);
    const state: ChannelState = route === null ? 'unregistered' : route.closed ? 'closed' : 'active';
    const unacked = this.#db.countPending(sessionId);
    return {
      sessionId,
      state,
      route,
      queue: this.#db.queueStats(sessionId, now),
      unacked,
      drained: state === 'closed' && unacked === 0,
    };
  }

  isDrained(sessionId: string): boolean {
    return this.status(sessionId).drained;
  }

  watchForDrain(sessionId: string, options: DrainWatchOptions): () => void {
    const timer = setInterval(() => {
      if (!this.isDrained(sessionId)) return;
      clearInterval(timer);
      options.onDrained();
    }, options.intervalMs);
    return () => clearInterval(timer);
  }
}

// StdioServerTransport listens for 'data' and 'error' only, so a client that closes the
// pipe never reaches transport.onclose and the channel would outlive its session.
export function watchClientDisconnect(stdin: NodeJS.ReadableStream, onDisconnect: () => void): () => void {
  let reported = false;
  const stop = (): void => {
    stdin.off('end', handler);
    stdin.off('close', handler);
  };
  // 'end' and 'close' both fire on a closed pipe; the disconnect is one event.
  function handler(): void {
    if (reported) return;
    reported = true;
    stop();
    onDisconnect();
  }
  stdin.on('end', handler);
  stdin.on('close', handler);
  return stop;
}

export interface ChannelProcessOptions {
  readonly sessionId: string;
  readonly dbPath: string;
  readonly leaseMs: number;
}

export const SESSION_ID_ENV = 'PR_CHANNEL_SESSION_ID';
export const SESSION_ID_FLAG = '--session-id';

// The channel process does not load the full ServiceConfig: it has no business with
// the repo allowlist or the webhook secret, so it reads only what it needs.
export function channelProcessOptions(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ChannelProcessOptions {
  const flagIndex = argv.indexOf(SESSION_ID_FLAG);
  const fromFlag = flagIndex === -1 ? undefined : argv[flagIndex + 1];
  const sessionId = (fromFlag ?? env[SESSION_ID_ENV] ?? '').trim();
  if (sessionId.length === 0 || sessionId.startsWith('--')) {
    throw new ConfigError(`session id is required: pass ${SESSION_ID_FLAG} <id> or set ${SESSION_ID_ENV}`);
  }

  const rawLease = env[ENV.leaseTimeoutMs];
  let leaseMs: number = DEFAULTS.leaseTimeoutMs;
  if (rawLease !== undefined && rawLease.trim() !== '') {
    leaseMs = Number(rawLease);
    if (!Number.isInteger(leaseMs) || leaseMs < 1) {
      throw new ConfigError(`${ENV.leaseTimeoutMs} must be an integer >= 1, got "${rawLease}"`);
    }
  }

  return {
    sessionId,
    dbPath: resolve((env[ENV.dbPath] ?? DEFAULTS.dbPath).trim() || DEFAULTS.dbPath),
    leaseMs,
  };
}

function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new TypeError('sessionId must be a non-empty string');
  }
}

function assertPrRef(prRef: PrRef): void {
  if (!REPO_PATTERN.test(prRef.repo)) throw new TypeError(`repo "${prRef.repo}" is not a lower-case owner/name`);
  if (!Number.isInteger(prRef.prNumber) || prRef.prNumber < 1) {
    throw new TypeError(`prNumber must be a positive integer, got ${prRef.prNumber}`);
  }
}
