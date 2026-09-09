import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
import type {
  CheckState,
  EventEnvelope,
  HeadSource,
  PrEvent,
  PrEventKind,
  PrRef,
  RouteLifecycleState,
  SessionRoute,
  UnroutedEvent,
} from '../types.js';

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE deliveries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id TEXT NOT NULL UNIQUE,
    event_name TEXT NOT NULL,
    repo TEXT,
    received_at TEXT NOT NULL
  );

  CREATE TABLE routes (
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    head_sha TEXT,
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('open', 'draft', 'closed', 'merged')),
    closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
    registered_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (repo, pr_number)
  );
  CREATE INDEX routes_by_session ON routes (session_id, updated_at);

  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    envelope TEXT NOT NULL,
    enqueued_at INTEGER NOT NULL,
    lease_until INTEGER,
    acked_at INTEGER
  );
  CREATE INDEX events_pending ON events (session_id, acked_at, lease_until, seq);

  CREATE TABLE unrouted_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id TEXT NOT NULL,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    kind TEXT NOT NULL,
    head_sha TEXT,
    reason TEXT NOT NULL,
    received_at TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX unrouted_by_pr ON unrouted_events (repo, pr_number, seq);
  `,
  `
  ALTER TABLE routes ADD COLUMN head_source TEXT;
  ALTER TABLE routes ADD COLUMN head_event_at TEXT;
  UPDATE routes SET head_source = 'registration' WHERE head_sha IS NOT NULL;

  CREATE TABLE route_heads (
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    PRIMARY KEY (repo, pr_number, head_sha)
  );
  INSERT OR IGNORE INTO route_heads (repo, pr_number, head_sha, first_seen_at)
    SELECT repo, pr_number, head_sha, updated_at FROM routes WHERE head_sha IS NOT NULL;
  `,
  `
  UPDATE routes SET head_event_at = updated_at WHERE head_sha IS NOT NULL AND head_event_at IS NULL;
  `,
  `
  CREATE TABLE check_states (
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    check_name TEXT NOT NULL,
    state TEXT NOT NULL,
    PRIMARY KEY (repo, pr_number, head_sha, check_name)
  );

  CREATE TABLE check_heads (
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    announced_checks TEXT,
    PRIMARY KEY (repo, pr_number, head_sha)
  );
  `,
  `
  ALTER TABLE check_states ADD COLUMN observed_at TEXT;
  ALTER TABLE check_heads ADD COLUMN announced_head_confirmed INTEGER NOT NULL DEFAULT 0;
  `,
  `
  ALTER TABLE routes ADD COLUMN worker_dir TEXT;
  `,
  `
  ALTER TABLE unrouted_events ADD COLUMN claimed_at TEXT;
  `,
];

export interface DeliveryRecord {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly repo: string | null;
  readonly receivedAtIso?: string;
}

export interface RegisterRouteInput {
  readonly prRef: PrRef;
  readonly sessionId: string;
  readonly headSha?: string | null;
  readonly headSource?: HeadSource;
  readonly headEventAtIso?: string | null;
  readonly lifecycle?: RouteLifecycleState;
  readonly workerDir?: string | null;
  readonly nowIso?: string;
}

export interface SetHeadOptions {
  readonly source?: HeadSource;
  readonly eventAtIso?: string | null;
  readonly nowIso?: string;
}

export interface CloseRouteOptions {
  readonly lifecycle?: 'closed' | 'merged';
  readonly sessionId?: string;
  readonly nowIso?: string;
}

export interface LeaseOptions {
  readonly leaseMs: number;
  readonly limit?: number;
  readonly now?: number;
}

export type AckResult = 'acked' | 'already_acked' | 'not_found';

export interface AnnouncedGreen {
  readonly signature: string;
  // Whether the announcement reached the session as a signal about the current head. A
  // suppressed one is history to the consumer, so it leaves the announcement unspent.
  readonly headConfirmed: boolean;
}

export interface QueueStats {
  readonly pending: number;
  readonly leased: number;
  readonly acked: number;
}

export function newEventId(): string {
  return randomUUID();
}

type Row = Record<string, SQLOutputValue>;

export class ChannelDb {
  readonly path: string;
  readonly #db: DatabaseSync;

  private constructor(path: string, db: DatabaseSync) {
    this.path = path;
    this.#db = db;
  }

  static open(path: string): ChannelDb {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
    const store = new ChannelDb(path, db);
    store.#migrate();
    return store;
  }

  close(): void {
    this.#db.close();
  }

  transaction<T>(fn: () => T): T {
    if (this.#db.isTransaction) return fn();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  recordDeliveryOnce(delivery: DeliveryRecord): boolean {
    const { changes } = this.#db
      .prepare('INSERT OR IGNORE INTO deliveries (delivery_id, event_name, repo, received_at) VALUES (?, ?, ?, ?)')
      .run(delivery.deliveryId, delivery.eventName, delivery.repo, delivery.receivedAtIso ?? nowIso());
    return changes === 1;
  }

  hasDelivery(deliveryId: string): boolean {
    return this.#db.prepare('SELECT 1 FROM deliveries WHERE delivery_id = ?').get(deliveryId) !== undefined;
  }

  upsertRoute(input: RegisterRouteInput): SessionRoute {
    const now = input.nowIso ?? nowIso();
    return this.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO routes
             (repo, pr_number, session_id, head_sha, head_source, head_event_at, lifecycle, closed, registered_at, updated_at, worker_dir)
           VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, 'open'), 0, ?, ?, ?)
           ON CONFLICT (repo, pr_number) DO UPDATE SET
             session_id = excluded.session_id,
             head_sha = COALESCE(excluded.head_sha, routes.head_sha),
             -- Re-asserting the head the route already holds must not downgrade how that
             -- head was learned, nor drop the ordering stamp that keeps it from rewinding.
             head_source = CASE WHEN excluded.head_sha IS NULL OR excluded.head_sha = routes.head_sha
               THEN routes.head_source ELSE excluded.head_source END,
             head_event_at = CASE WHEN excluded.head_sha IS NULL OR excluded.head_sha = routes.head_sha
               THEN routes.head_event_at ELSE excluded.head_event_at END,
             lifecycle = COALESCE(?, routes.lifecycle),
             closed = 0,
             worker_dir = COALESCE(excluded.worker_dir, routes.worker_dir),
             updated_at = excluded.updated_at`,
        )
        .run(
          input.prRef.repo,
          input.prRef.prNumber,
          input.sessionId,
          input.headSha ?? null,
          input.headSha == null ? null : (input.headSource ?? 'registration'),
          input.headSha == null ? null : (input.headEventAtIso ?? null),
          input.lifecycle ?? null,
          now,
          now,
          input.workerDir ?? null,
          input.lifecycle ?? null,
        );
      const route = this.#requireRoute(input.prRef);
      if (route.headSha !== null) this.#rememberHead(input.prRef, route.headSha, now);
      return route;
    });
  }

  // Every sha this PR has had as its head. A force-push can legitimately put one back in
  // force, so this only breaks a tie between head assertions that carry the same instant.
  hasSeenHead(prRef: PrRef, headSha: string): boolean {
    return (
      this.#db
        .prepare('SELECT 1 FROM route_heads WHERE repo = ? AND pr_number = ? AND head_sha = ?')
        .get(prRef.repo, prRef.prNumber, headSha) !== undefined
    );
  }

  listSeenHeads(prRef: PrRef): string[] {
    return this.#db
      .prepare('SELECT head_sha FROM route_heads WHERE repo = ? AND pr_number = ? ORDER BY first_seen_at, head_sha')
      .all(prRef.repo, prRef.prNumber)
      .map((row) => row['head_sha'] as string);
  }

  // Every PR that has ever carried this sha as its head, closed routes included: a check
  // delivery naming no PR still belongs to whichever route once stood on that commit.
  findPrsBySeenHead(repo: string, headSha: string): PrRef[] {
    return this.#db
      .prepare('SELECT pr_number FROM route_heads WHERE repo = ? AND head_sha = ? ORDER BY pr_number')
      .all(repo, headSha)
      .map((row) => ({ repo, prNumber: Number(row['pr_number']) }));
  }

  #rememberHead(prRef: PrRef, headSha: string, atIso: string): void {
    this.#db
      .prepare(
        'INSERT OR IGNORE INTO route_heads (repo, pr_number, head_sha, first_seen_at) VALUES (?, ?, ?, ?)',
      )
      .run(prRef.repo, prRef.prNumber, headSha, atIso);
  }

  getRoute(prRef: PrRef): SessionRoute | null {
    const row = this.#db
      .prepare('SELECT * FROM routes WHERE repo = ? AND pr_number = ?')
      .get(prRef.repo, prRef.prNumber);
    return row ? toRoute(row) : null;
  }

  findOpenRoute(prRef: PrRef): SessionRoute | null {
    const route = this.getRoute(prRef);
    return route && !route.closed ? route : null;
  }

  getRouteBySession(sessionId: string): SessionRoute | null {
    const row = this.#db
      .prepare('SELECT * FROM routes WHERE session_id = ? ORDER BY closed ASC, updated_at DESC LIMIT 1')
      .get(sessionId);
    return row ? toRoute(row) : null;
  }

  listOpenRoutes(): SessionRoute[] {
    return this.#db
      .prepare('SELECT * FROM routes WHERE closed = 0 ORDER BY repo, pr_number')
      .all()
      .map(toRoute);
  }

  setHeadSha(prRef: PrRef, headSha: string, options: SetHeadOptions = {}): boolean {
    const at = options.nowIso ?? nowIso();
    return this.transaction(() => {
      const { changes } = this.#db
        .prepare(
          `UPDATE routes SET head_sha = ?, head_source = ?, head_event_at = ?, updated_at = ?
           WHERE repo = ? AND pr_number = ?`,
        )
        .run(headSha, options.source ?? 'registration', options.eventAtIso ?? null, at, prRef.repo, prRef.prNumber);
      if (changes !== 1) return false;
      this.#rememberHead(prRef, headSha, at);
      return true;
    });
  }

  setLifecycle(prRef: PrRef, lifecycle: RouteLifecycleState, nowIso_: string = nowIso()): boolean {
    const { changes } = this.#db
      .prepare('UPDATE routes SET lifecycle = ?, updated_at = ? WHERE repo = ? AND pr_number = ?')
      .run(lifecycle, nowIso_, prRef.repo, prRef.prNumber);
    return changes === 1;
  }

  closeRoute(prRef: PrRef, options: CloseRouteOptions = {}): boolean {
    const sets = ['closed = 1', 'updated_at = ?'];
    const params: SQLInputValue[] = [options.nowIso ?? nowIso()];
    if (options.lifecycle !== undefined) {
      sets.push('lifecycle = ?');
      params.push(options.lifecycle);
    }
    let where = 'repo = ? AND pr_number = ? AND closed = 0';
    params.push(prRef.repo, prRef.prNumber);
    if (options.sessionId !== undefined) {
      where += ' AND session_id = ?';
      params.push(options.sessionId);
    }
    const { changes } = this.#db.prepare(`UPDATE routes SET ${sets.join(', ')} WHERE ${where}`).run(...params);
    return changes === 1;
  }

  deleteRoute(prRef: PrRef): boolean {
    return this.transaction(() => {
      const { changes } = this.#db
        .prepare('DELETE FROM routes WHERE repo = ? AND pr_number = ?')
        .run(prRef.repo, prRef.prNumber);
      this.#db
        .prepare('DELETE FROM route_heads WHERE repo = ? AND pr_number = ?')
        .run(prRef.repo, prRef.prNumber);
      this.forgetCheckStates(prRef);
      return changes === 1;
    });
  }

  enqueueEvent(envelope: EventEnvelope, now: number = Date.now()): boolean {
    const { changes } = this.#db
      .prepare('INSERT OR IGNORE INTO events (id, session_id, envelope, enqueued_at) VALUES (?, ?, ?, ?)')
      .run(envelope.id, envelope.sessionId, JSON.stringify(envelope), now);
    return changes === 1;
  }

  // Whether an event of this kind for this head is still queued and has never been handed
  // to the session holding the route -- the only copy poll-time re-evaluation can still
  // correct. A leased one does not count: the session is handling it as delivered and acks
  // it, so nothing redelivers it. Scoped by session so it reads the few unacked rows
  // behind events_pending, not the whole table.
  hasUndeliveredEventForHead(prRef: PrRef, headSha: string, kind: PrEventKind): boolean {
    return (
      this.#db
        .prepare(
          `SELECT 1 FROM events
           WHERE session_id = (SELECT session_id FROM routes WHERE repo = ? AND pr_number = ?)
             AND acked_at IS NULL
             AND lease_until IS NULL
             AND json_extract(envelope, '$.kind') = ?
             AND json_extract(envelope, '$.headSha') = ?
             AND json_extract(envelope, '$.prRef.repo') = ?
             AND json_extract(envelope, '$.prRef.prNumber') = ?
           LIMIT 1`,
        )
        .get(prRef.repo, prRef.prNumber, kind, headSha, prRef.repo, prRef.prNumber) !== undefined
    );
  }

  leaseEvents(sessionId: string, options: LeaseOptions): EventEnvelope[] {
    const now = options.now ?? Date.now();
    const limit = options.limit ?? 50;
    return this.transaction(() => {
      const rows = this.#db
        .prepare(
          `SELECT id, envelope FROM events
           WHERE session_id = ? AND acked_at IS NULL AND (lease_until IS NULL OR lease_until <= ?)
           ORDER BY seq LIMIT ?`,
        )
        .all(sessionId, now, limit);
      const lease = this.#db.prepare('UPDATE events SET lease_until = ? WHERE id = ?');
      const leaseUntil = now + options.leaseMs;
      const envelopes: EventEnvelope[] = [];
      for (const row of rows) {
        lease.run(leaseUntil, row['id'] as string);
        envelopes.push(JSON.parse(row['envelope'] as string) as EventEnvelope);
      }
      return envelopes;
    });
  }

  ackEvent(eventId: string, now: number = Date.now()): AckResult {
    return this.transaction(() => {
      const row = this.#db.prepare('SELECT acked_at FROM events WHERE id = ?').get(eventId);
      if (!row) return 'not_found';
      if (row['acked_at'] !== null) return 'already_acked';
      this.#db.prepare('UPDATE events SET acked_at = ?, lease_until = NULL WHERE id = ?').run(now, eventId);
      return 'acked';
    });
  }

  countPending(sessionId: string): number {
    return this.#count('SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND acked_at IS NULL', sessionId);
  }

  queueStats(sessionId: string, now: number = Date.now()): QueueStats {
    const row = this.#db
      .prepare(
        `SELECT
           SUM(acked_at IS NULL AND (lease_until IS NULL OR lease_until <= ?)) AS pending,
           SUM(acked_at IS NULL AND lease_until IS NOT NULL AND lease_until > ?) AS leased,
           SUM(acked_at IS NOT NULL) AS acked
         FROM events WHERE session_id = ?`,
      )
      .get(now, now, sessionId);
    return {
      pending: Number(row?.['pending'] ?? 0),
      leased: Number(row?.['leased'] ?? 0),
      acked: Number(row?.['acked'] ?? 0),
    };
  }

  // Per-head check states back the derived all-required-green. They are durable because
  // the contract promises that event unconditionally: a dispatcher that restarts halfway
  // through a CI run must still complete the set from the greens already banked.
  // GitHub orders nothing, so a state that is older than the one already banked is
  // refused rather than written -- the discipline PrRegistry applies to the head, applied
  // to the checks under it. Returns whether the state was taken.
  recordCheckState(
    prRef: PrRef,
    headSha: string,
    checkName: string,
    state: CheckState,
    observedAtIso: string,
  ): boolean {
    return this.transaction(() => {
      const previous = this.#db
        .prepare(
          'SELECT observed_at FROM check_states WHERE repo = ? AND pr_number = ? AND head_sha = ? AND check_name = ?',
        )
        .get(prRef.repo, prRef.prNumber, headSha, checkName);
      if (previous !== undefined && !supersedes(observedAtIso, previous['observed_at'] as string | null)) return false;
      this.#trackCheckHead(prRef, headSha);
      this.#db
        .prepare(
          `INSERT INTO check_states (repo, pr_number, head_sha, check_name, state, observed_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (repo, pr_number, head_sha, check_name) DO UPDATE SET
             state = excluded.state, observed_at = excluded.observed_at`,
        )
        .run(prRef.repo, prRef.prNumber, headSha, checkName, JSON.stringify(state), observedAtIso);
      return true;
    });
  }

  checkStates(prRef: PrRef, headSha: string): Map<string, CheckState> {
    const states = new Map<string, CheckState>();
    for (const row of this.#db
      .prepare('SELECT check_name, state FROM check_states WHERE repo = ? AND pr_number = ? AND head_sha = ?')
      .all(prRef.repo, prRef.prNumber, headSha)) {
      states.set(row['check_name'] as string, JSON.parse(row['state'] as string) as CheckState);
    }
    return states;
  }

  // The required-check list last announced green for this head, or null while it is not
  // green. Naming the list rather than raising a flag keeps "announced once per head"
  // honest when the configured list itself changes.
  announcedChecks(prRef: PrRef, headSha: string): AnnouncedGreen | null {
    const row = this.#db
      .prepare(
        `SELECT announced_checks, announced_head_confirmed FROM check_heads
         WHERE repo = ? AND pr_number = ? AND head_sha = ?`,
      )
      .get(prRef.repo, prRef.prNumber, headSha);
    const signature = (row?.['announced_checks'] as string | null) ?? null;
    return signature === null ? null : { signature, headConfirmed: row?.['announced_head_confirmed'] === 1 };
  }

  setAnnouncedChecks(prRef: PrRef, headSha: string, announced: AnnouncedGreen | null): void {
    this.transaction(() => {
      this.#trackCheckHead(prRef, headSha);
      this.#db
        .prepare(
          `UPDATE check_heads SET announced_checks = ?, announced_head_confirmed = ?
           WHERE repo = ? AND pr_number = ? AND head_sha = ?`,
        )
        .run(announced?.signature ?? null, announced?.headConfirmed === true ? 1 : 0, prRef.repo, prRef.prNumber, headSha);
    });
  }

  forgetCheckStates(prRef: PrRef): void {
    this.transaction(() => {
      this.#db.prepare('DELETE FROM check_states WHERE repo = ? AND pr_number = ?').run(prRef.repo, prRef.prNumber);
      this.#db.prepare('DELETE FROM check_heads WHERE repo = ? AND pr_number = ?').run(prRef.repo, prRef.prNumber);
    });
  }

  // Bounds what one long-lived PR can accumulate, oldest head first. Only heads outside
  // the `keep` most recently seen ones go: a head is never dropped for the mere fact that
  // the registry has not reached it yet.
  pruneCheckHeads(prRef: PrRef, keep: number): void {
    const tracked = this.#count(
      'SELECT COUNT(*) AS n FROM check_heads WHERE repo = ? AND pr_number = ?',
      prRef.repo,
      prRef.prNumber,
    );
    if (tracked <= keep) return;
    this.transaction(() => {
      this.#db
        .prepare(
          `DELETE FROM check_heads WHERE repo = ? AND pr_number = ? AND rowid NOT IN (
             SELECT rowid FROM check_heads WHERE repo = ? AND pr_number = ? ORDER BY rowid DESC LIMIT ?)`,
        )
        .run(prRef.repo, prRef.prNumber, prRef.repo, prRef.prNumber, keep);
      this.#db
        .prepare(
          `DELETE FROM check_states WHERE repo = ? AND pr_number = ? AND head_sha NOT IN (
             SELECT head_sha FROM check_heads WHERE repo = ? AND pr_number = ?)`,
        )
        .run(prRef.repo, prRef.prNumber, prRef.repo, prRef.prNumber);
    });
  }

  #trackCheckHead(prRef: PrRef, headSha: string): void {
    this.#db
      .prepare('INSERT OR IGNORE INTO check_heads (repo, pr_number, head_sha, announced_checks) VALUES (?, ?, ?, NULL)')
      .run(prRef.repo, prRef.prNumber, headSha);
  }

  recordUnrouted(event: UnroutedEvent): void {
    this.#db
      .prepare(
        `INSERT INTO unrouted_events (delivery_id, repo, pr_number, kind, head_sha, reason, received_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.deliveryId,
        event.prRef.repo,
        event.prRef.prNumber,
        event.payload.kind,
        event.payload.headSha,
        event.reason,
        event.receivedAtIso,
        JSON.stringify(event.payload),
      );
  }

  // Events that arrived before any session claimed this PR. A worker almost always
  // starts on a PR that already has CI results and comments, so registration replays
  // them instead of leaving the session blind to the state it is joining.
  claimUnrouted(prRef: PrRef, nowIso_: string = nowIso()): { deliveryId: string; receivedAtIso: string; payload: PrEvent }[] {
    const rows = this.#db
      .prepare(
        `SELECT seq, delivery_id, received_at, payload FROM unrouted_events
         WHERE repo = ? AND pr_number = ? AND claimed_at IS NULL
         ORDER BY seq`,
      )
      .all(prRef.repo, prRef.prNumber) as Row[];
    if (rows.length === 0) return [];
    const mark = this.#db.prepare('UPDATE unrouted_events SET claimed_at = ? WHERE seq = ?');
    const claimed: { deliveryId: string; receivedAtIso: string; payload: PrEvent }[] = [];
    for (const row of rows) {
      mark.run(nowIso_, row['seq'] as number);
      claimed.push({
        deliveryId: row['delivery_id'] as string,
        receivedAtIso: row['received_at'] as string,
        payload: JSON.parse(row['payload'] as string) as PrEvent,
      });
    }
    return claimed;
  }

  countUnrouted(prRef?: PrRef): number {
    return prRef
      ? this.#count(
          'SELECT COUNT(*) AS n FROM unrouted_events WHERE repo = ? AND pr_number = ?',
          prRef.repo,
          prRef.prNumber,
        )
      : this.#count('SELECT COUNT(*) AS n FROM unrouted_events');
  }

  #count(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.#db.prepare(sql).get(...params)?.['n'] ?? 0);
  }

  #requireRoute(prRef: PrRef): SessionRoute {
    const route = this.getRoute(prRef);
    if (!route) throw new Error(`route ${prRef.repo}#${prRef.prNumber} vanished inside a transaction`);
    return route;
  }

  #migrate(): void {
    this.#db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    this.transaction(() => {
      const applied = Number(this.#db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.['v'] ?? 0);
      MIGRATIONS.forEach((sql, index) => {
        const version = index + 1;
        if (version <= applied) return;
        this.#db.exec(sql);
        this.#db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, nowIso());
      });
    });
  }
}

function toRoute(row: Row): SessionRoute {
  return {
    prRef: { repo: row['repo'] as string, prNumber: Number(row['pr_number']) },
    sessionId: row['session_id'] as string,
    headSha: (row['head_sha'] as string | null) ?? null,
    headSource: (row['head_source'] as SessionRoute['headSource'] | null) ?? null,
    headEventAtIso: (row['head_event_at'] as string | null) ?? null,
    lifecycle: row['lifecycle'] as RouteLifecycleState,
    closed: row['closed'] === 1,
    workerDir: (row['worker_dir'] as string | null) ?? null,
    registeredAtIso: row['registered_at'] as string,
    updatedAtIso: row['updated_at'] as string,
  };
}

// Equal instants fall through to the newest delivery: a re-run that finished inside the
// same second is indistinguishable from a redelivery, and only the re-run says anything
// new. An unstamped row predates the ordering column and loses.
function supersedes(incomingAtIso: string, storedAtIso: string | null): boolean {
  if (storedAtIso === null) return true;
  const incoming = Date.parse(incomingAtIso);
  const stored = Date.parse(storedAtIso);
  if (Number.isNaN(incoming) || Number.isNaN(stored)) return true;
  return incoming >= stored;
}

function nowIso(): string {
  return new Date().toISOString();
}
