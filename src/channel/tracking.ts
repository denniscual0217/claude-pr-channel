import type { Config } from '../config.js';
import { DeliveryDeduper } from '../events/dedupe.js';
import { HeadTracker } from '../events/head.js';
import { normalizeRepo, parsePrRef } from '../events/repo.js';
import { RequiredChecksTracker } from '../events/required-checks.js';
import type { GhClient, PrInfo } from '../github/gh.js';
import { GhError } from '../github/gh.js';
import type { Forwarder, SpawnForwarder } from '../github/forwarder.js';
import { createForwarder, ForwarderError } from '../github/forwarder.js';
import type { MarkerHandle, SweepOptions, SweepResult } from '../github/markers.js';
import { sweep as realSweep, writeMarker } from '../github/markers.js';
import type { Logger } from '../log.js';
import { noopLogger } from '../log.js';
import { ALLOWED_GITHUB_EVENTS, prKey, type PrRef, type TerminalLifecycleAction } from '../types.js';
import type { Listener, ListenerOptions } from '../webhook/listener.js';
import { createListener as realCreateListener } from '../webhook/listener.js';
import { generateWebhookSecret, type WebhookSecret } from '../webhook/secret.js';
import type { CiEvents } from './filter.js';
import { createPipeline, type Pipeline } from './pipeline.js';
import type { ChannelNotifier } from './server.js';

export type TrackingState = 'idle' | 'starting' | 'tracking' | 'stopping';

export class ToolError extends Error {
  override readonly name = 'ToolError';
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface JanitorHandle {
  readonly pid: number;
  readonly processStart: string | null;
  send(message: Record<string, unknown>): void;
  closeStdin(): void;
}

export interface TrackInput {
  readonly pr?: string;
  readonly repo?: string;
  readonly ci_events?: CiEvents;
  readonly required_checks?: readonly string[];
  readonly comment_authors?: readonly string[];
  readonly bot_comments?: 'handle' | 'ignore';
  readonly replace?: boolean;
}

export interface TrackingDeps {
  readonly gh: GhClient;
  readonly config: Config;
  readonly notifier: ChannelNotifier;
  readonly sessionId: string | null;
  readonly projectDir: string;
  readonly spawnForwarder: SpawnForwarder;
  readonly spawnJanitor: (repo: string) => JanitorHandle;
  readonly createListener?: (options: ListenerOptions) => Listener;
  readonly sweep?: (gh: GhClient, options: SweepOptions) => Promise<SweepResult>;
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly wait?: (ms: number) => Promise<void>;
  readonly processStart?: (pid: number) => string | null;
  readonly connectTimeoutMs?: number;
  readonly hookDiscoveryMs?: number;
  readonly hookPollMs?: number;
  readonly hookDeleteTimeoutMs?: number;
  readonly backoffStartMs?: number;
  readonly backoffMaxMs?: number;
}

interface ActiveTracking {
  readonly prRef: PrRef;
  readonly pr: PrInfo;
  readonly head: HeadTracker;
  readonly listener: Listener;
  readonly forwarder: Forwarder;
  readonly janitor: JanitorHandle;
  readonly marker: MarkerHandle;
  readonly pipeline: Pipeline;
  readonly requiredChecks: RequiredChecksTracker;
  readonly ciEvents: CiEvents;
  readonly commentAuthors: ReadonlySet<string> | null;
  readonly startedAtIso: string;
  hookId: number | null;
  candidates: number[];
  secret: WebhookSecret | null;
}

export interface EndedInfo {
  readonly reason: TerminalLifecycleAction;
  readonly prRef: PrRef;
  readonly atIso: string;
}

export class Tracking {
  readonly #deps: TrackingDeps;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #wait: (ms: number) => Promise<void>;
  #state: TrackingState = 'idle';
  #active: ActiveTracking | null = null;
  #ended: EndedInfo | null = null;
  #pingedHookIds = new Set<number>();

  constructor(deps: TrackingDeps) {
    this.#deps = deps;
    this.#log = deps.logger ?? noopLogger;
    this.#now = deps.now ?? (() => new Date());
    this.#wait = deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get state(): TrackingState {
    return this.#state;
  }

  get trackedPr(): PrRef | null {
    return this.#active?.prRef ?? null;
  }

  async track(input: TrackInput): Promise<string> {
    if (this.#state === 'starting' || this.#state === 'stopping') {
      throw new ToolError('busy', `tracking is ${this.#state}; try again in a moment`);
    }
    if (this.#active !== null) {
      if (input.replace !== true) {
        throw new ToolError(
          'already_tracking',
          `this session already tracks ${prKey(this.#active.prRef)}; pass replace:true to switch, or call untrack first`,
        );
      }
      await this.untrack();
    }

    this.#state = 'starting';
    try {
      return await this.#start(input);
    } catch (error) {
      this.#state = 'idle';
      throw error;
    }
  }

  async #start(input: TrackInput): Promise<string> {
    const gh = this.#deps.gh;
    const login = await this.#ghLogin();
    const pr = await this.#resolvePr(input);
    if (pr.state !== 'OPEN') {
      throw new ToolError(
        'pr_closed',
        `${pr.repo}#${pr.number} is ${pr.state.toLowerCase()}; there is nothing left to track`,
      );
    }
    await this.#requireWebhookExtension();

    const prRef: PrRef = { repo: normalizeRepo(pr.repo), prNumber: pr.number };
    const sweepResult = await this.#sweep(prRef.repo);

    const ciEvents = input.ci_events ?? this.#deps.config.ciEvents;
    const requiredChecks = input.required_checks ?? this.#deps.config.requiredChecks;
    const commentAuthors = resolveCommentAuthors(input.comment_authors, this.#deps.config.commentAuthors, login);
    const botComments = input.bot_comments ?? this.#deps.config.botComments;

    const head = new HeadTracker(prRef, pr.isDraft ? 'draft' : 'open');
    head.seed(pr.headRefOid, this.#now().toISOString());

    const secret = generateWebhookSecret();
    const checks = new RequiredChecksTracker(requiredChecks);
    const deduper = new DeliveryDeduper();

    this.#pingedHookIds = new Set();
    const pipelineRef: { current: Pipeline | null } = { current: null };

    // The listener is up before gh exists, so no delivery can arrive at a closed port.
    const listener = (this.#deps.createListener ?? realCreateListener)({
      verifier: secret,
      expectedRepo: prRef.repo,
      maxPayloadBytes: this.#deps.config.maxPayloadBytes,
      rateLimit: this.#deps.config.rateLimit,
      onDelivery: async (headers, payload) => {
        await pipelineRef.current?.handleDelivery(headers, payload);
      },
      // A ping that verified against OUR secret is the only proof of which hook id is
      // ours when several appeared at once.
      onPing: (payload) => {
        const hookId = typeof payload['hook_id'] === 'number' ? payload['hook_id'] : null;
        if (hookId !== null) this.#pingedHookIds.add(hookId);
      },
      logger: (entry) => this.#log('debug', 'listener', { ...entry }),
    });

    const marker = writeMarker({
      repo: prRef.repo,
      sessionId: this.#deps.sessionId,
      cacheDir: this.#deps.config.cacheDir,
    });
    const janitor = this.#deps.spawnJanitor(prRef.repo);
    janitor.send({ repo: prRef.repo, marker: marker.path });
    marker.update({ janitorPid: janitor.pid, janitorStart: janitor.processStart });

    // Refreshed before every launch: gh creates a new hook each time, so what counts as
    // "new" is measured against the hooks in place immediately before it starts.
    const snapshot = { ids: new Set((await this.#listHooks(prRef.repo)).map((hook) => hook.id)) };

    const forwarder = createForwarder({
      repo: prRef.repo,
      events: [...ALLOWED_GITHUB_EVENTS],
      url: listener.url,
      secret: secret.reveal(),
      spawn: this.#deps.spawnForwarder,
      ...(this.#deps.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: this.#deps.connectTimeoutMs }),
      ...(this.#deps.backoffStartMs === undefined ? {} : { backoffStartMs: this.#deps.backoffStartMs }),
      ...(this.#deps.backoffMaxMs === undefined ? {} : { backoffMaxMs: this.#deps.backoffMaxMs }),
      logger: this.#log,
      wait: this.#wait,
      ...(this.#deps.processStart === undefined ? {} : { processStart: this.#deps.processStart }),
      onBeforeRespawn: async () => {
        // gh creates a new hook every launch and leaves the old one active.
        const active = this.#active;
        if (active?.hookId != null) {
          await this.#deleteHookQuietly(active.prRef.repo, active.hookId);
          active.hookId = null;
          active.marker.update({ hookId: null });
          active.janitor.send({ hookId: null });
        }
        this.#pingedHookIds.clear();
        snapshot.ids = new Set((await this.#listHooks(prRef.repo)).map((hook) => hook.id));
      },
      onConnected: async () => {
        const active = this.#active;
        if (active === null) return;
        const rediscovered = await this.#discoverHookId(active.prRef.repo, snapshot.ids);
        active.hookId = rediscovered.hookId;
        active.candidates = [...rediscovered.candidates];
        active.marker.update({
          hookId: rediscovered.hookId,
          candidates: [...rediscovered.candidates],
          ghPid: forwarder.pid,
          ghStart: forwarder.processStart,
        });
        active.janitor.send({
          hookId: rediscovered.hookId,
          candidates: [...rediscovered.candidates],
          ghPid: forwarder.pid,
          ghStart: forwarder.processStart,
        });
      },
    });

    const pipeline = createPipeline({
      prRef,
      head,
      deduper,
      requiredChecks: checks,
      notifier: this.#deps.notifier,
      ciEvents,
      commentAuthors,
      botComments,
      logger: this.#log,
      now: this.#now,
      onTerminal: (action) => {
        this.#log('info', 'pr_terminal', { pr: prKey(prRef), action });
        void this.#autoStop(action);
      },
    });
    pipelineRef.current = pipeline;

    const active: ActiveTracking = {
      prRef,
      pr,
      head,
      listener,
      forwarder,
      janitor,
      marker,
      pipeline,
      requiredChecks: checks,
      ciEvents,
      commentAuthors,
      startedAtIso: this.#now().toISOString(),
      hookId: null,
      candidates: [],
      secret,
    };
    this.#active = active;

    try {
      await forwarder.start();
    } catch (error) {
      await this.#teardown(active, { deleteHooks: true });
      const tail = error instanceof ForwarderError ? error.stderrTail : '';
      throw new ToolError(
        'forwarder_failed',
        `gh webhook forward did not connect${tail === '' ? '' : `: ${tail}`}. A 403 here ("you do not have access to this feature") means the token is not an admin on ${prRef.repo}.`,
      );
    }
    marker.update({ ghPid: forwarder.pid, ghStart: forwarder.processStart });
    janitor.send({ ghPid: forwarder.pid, ghStart: forwarder.processStart });

    const discovered = await this.#discoverHookId(prRef.repo, snapshot.ids);
    active.candidates = [...discovered.candidates];
    marker.update({ candidates: [...discovered.candidates] });
    janitor.send({ candidates: [...discovered.candidates] });

    if (discovered.hookId === null) {
      await this.#teardown(active, { deleteHooks: true });
      const listed = discovered.candidates.length === 0 ? 'none were seen' : discovered.candidates.join(', ');
      throw new ToolError(
        'hook_unresolved',
        `gh connected but no webhook id could be confirmed. Candidate ids: ${listed}. ` +
          `Delete any stray hook with: gh api -X DELETE repos/${prRef.repo}/hooks/<id>`,
      );
    }

    active.hookId = discovered.hookId;
    marker.update({ hookId: discovered.hookId, candidates: [] });
    janitor.send({ hookId: discovered.hookId, candidates: [] });
    this.#state = 'tracking';
    this.#ended = null;
    this.#log('info', 'tracking_started', {
      pr: prKey(prRef),
      hook_id: discovered.hookId,
      port: listener.port,
      head_sha: head.headSha,
    });

    return this.#startedText(active, sweepResult, requiredChecks);
  }

  async untrack(): Promise<string> {
    const active = this.#active;
    if (active === null) {
      const ended = this.#ended;
      return ended === null
        ? 'Nothing was being tracked in this session.'
        : `Nothing is being tracked: ${prKey(ended.prRef)} ended (${ended.reason}) at ${ended.atIso}.`;
    }
    this.#state = 'stopping';
    const counters = { ...active.pipeline.counters };
    const hookId = active.hookId;
    const outcome = await this.#teardown(active, { deleteHooks: true });
    this.#state = 'idle';

    const lines = [
      outcome.hookDeleted
        ? `Stopped tracking ${prKey(active.prRef)}. Deleted webhook ${hookId ?? 'unknown'}. Forwarder stopped.`
        : `Stopped tracking ${prKey(active.prRef)}. Forwarder and listener stopped, but webhook ${hookId ?? 'unknown'} could NOT be deleted; ` +
          'its marker is kept and the janitor is still retrying. The next track in this session sweeps it.',
      countersLine(counters),
    ];
    if (!outcome.hookDeleted) {
      throw new ToolError('hook_delete_failed', lines.join('\n'));
    }
    return lines.join('\n');
  }

  async status(verify = false): Promise<string> {
    const active = this.#active;
    if (active === null) {
      const ended = this.#ended;
      return ended === null
        ? 'tracking: no'
        : [`tracking: no`, `ended: ${ended.reason} at ${ended.atIso}`, `last pr: ${prKey(ended.prRef)}`].join('\n');
    }
    const counters = active.pipeline.counters;
    const lines = [
      'tracking: yes',
      `pr: ${prKey(active.prRef)} (${active.pr.url})`,
      `head: ${active.head.headSha ?? 'unknown'} (source: ${active.head.headSource ?? 'none'}, last lifecycle: ${
        active.head.lastLifecycleAction ?? 'none'
      })`,
      `hook: ${active.hookId ?? 'unconfirmed'}`,
      `forwarder: ${forwarderLine(active.forwarder)}`,
      `listener: 127.0.0.1:${active.listener.port}`,
      `last delivery: ${active.pipeline.lastDeliveryAtIso ?? 'none yet'}`,
      `filters: ci_events=${active.ciEvents}, required_checks=[${active.requiredChecks.requiredChecks.join(', ')}], comment_authors=${
        active.commentAuthors === null ? 'anyone' : [...active.commentAuthors].join(', ')
      }`,
      countersLine(counters),
    ];
    if (verify && active.hookId !== null) {
      try {
        const hook = await this.#deps.gh.hook(active.prRef.repo, active.hookId);
        lines.push(
          hook === null
            ? `github: hook ${active.hookId} is GONE — events are not arriving; untrack and track again`
            : `github: hook ${active.hookId} exists, active=${hook.active}`,
        );
      } catch {
        lines.push(`github: could not be asked about hook ${active.hookId}`);
      }
    }
    return lines.join('\n');
  }

  async shutdown(): Promise<void> {
    const active = this.#active;
    if (active === null) return;
    this.#state = 'stopping';
    await this.#teardown(active, { deleteHooks: true });
    this.#state = 'idle';
  }

  async #autoStop(action: TerminalLifecycleAction): Promise<void> {
    const active = this.#active;
    if (active === null) return;
    const prRef = active.prRef;
    this.#state = 'stopping';
    await this.#teardown(active, { deleteHooks: true });
    this.#state = 'idle';
    this.#ended = { reason: action, prRef, atIso: this.#now().toISOString() };
  }

  // Order is the contract: the listener stops first so nothing is half-processed, gh
  // next so it cannot recreate anything, and only then is the hook deleted.
  async #teardown(active: ActiveTracking, options: { deleteHooks: boolean }): Promise<{ hookDeleted: boolean }> {
    if (this.#active === active) this.#active = null;
    await active.listener.stop();
    await active.forwarder.stop();

    let hookDeleted = true;
    if (options.deleteHooks) {
      for (const hookId of [...new Set([...(active.hookId === null ? [] : [active.hookId]), ...active.candidates])]) {
        const gone = await this.#deleteHookQuietly(active.prRef.repo, hookId);
        if (!gone) hookDeleted = false;
      }
    }

    if (hookDeleted) {
      active.marker.remove();
      // The janitor has nothing left to do, and says so before its pipe closes.
      active.janitor.send({ done: true });
    }
    active.janitor.closeStdin();
    active.secret = null;
    active.requiredChecks.forget();
    this.#log('info', 'tracking_stopped', { pr: prKey(active.prRef), hook_deleted: hookDeleted });
    return { hookDeleted };
  }

  async #deleteHookQuietly(repo: string, hookId: number): Promise<boolean> {
    try {
      await this.#deps.gh.deleteHook(repo, hookId);
      return true;
    } catch {
      this.#log('warn', 'hook_delete_failed', { repo, hook_id: hookId });
      return false;
    }
  }

  async #discoverHookId(
    repo: string,
    snapshot: ReadonlySet<number>,
  ): Promise<{ hookId: number | null; candidates: readonly number[] }> {
    const deadline = this.#now().getTime() + (this.#deps.hookDiscoveryMs ?? 20_000);
    const pollMs = this.#deps.hookPollMs ?? 1_000;
    const candidates = new Set<number>();
    const pinged = new Set<number>();

    for (;;) {
      for (const hookId of this.#pingedHookIds) {
        if (!snapshot.has(hookId)) return { hookId, candidates: [...candidates] };
      }
      let listed: readonly { id: number }[] = [];
      try {
        listed = await this.#listHooks(repo);
      } catch {
        listed = [];
      }
      for (const hook of listed) {
        if (!snapshot.has(hook.id)) candidates.add(hook.id);
      }
      for (const hookId of candidates) {
        if (pinged.has(hookId)) continue;
        pinged.add(hookId);
        try {
          await this.#deps.gh.pingHook(repo, hookId);
        } catch {
          // A ping we cannot send just means this candidate stays unconfirmed.
        }
      }
      for (const hookId of this.#pingedHookIds) {
        if (!snapshot.has(hookId)) return { hookId, candidates: [...candidates] };
      }
      if (this.#now().getTime() >= deadline) break;
      await this.#wait(pollMs);
    }

    // Exactly one new hook and no signed ping is still unambiguous: nothing else appeared
    // on this repo in the window.
    const list = [...candidates];
    return { hookId: list.length === 1 ? (list[0] as number) : null, candidates: list };
  }

  async #listHooks(repo: string): Promise<readonly { id: number }[]> {
    try {
      return await this.#deps.gh.listCliHooks(repo);
    } catch (error) {
      if (error instanceof GhError && error.code === 'gh_unauthenticated') throw error;
      return [];
    }
  }

  async #ghLogin(): Promise<string | null> {
    try {
      return await this.#deps.gh.authLogin();
    } catch (error) {
      throw new ToolError(
        'gh_unauthenticated',
        `gh is not authenticated for this machine: ${error instanceof GhError ? error.stderrTail : 'run gh auth login'}`,
      );
    }
  }

  async #requireWebhookExtension(): Promise<void> {
    if (await this.#deps.gh.extensionInstalled('webhook')) return;
    throw new ToolError(
      'gh_webhook_extension_missing',
      'the gh-webhook extension is not installed; run: gh extension install cli/gh-webhook',
    );
  }

  async #resolvePr(input: TrackInput): Promise<PrInfo> {
    const { ref, repo } = parsePrRef(input.pr ?? '', input.repo ?? null);
    try {
      if (ref !== null) return await this.#deps.gh.prView(ref.repo, ref.prNumber);
      if ((input.pr ?? '').trim() !== '' && repo === null) {
        // A bare number with no repo: gh resolves it against the checkout it runs in.
        const current = await this.#deps.gh.prForCurrentBranch();
        return await this.#deps.gh.prView(current.repo, Number((input.pr as string).replace('#', '')));
      }
      return await this.#deps.gh.prForCurrentBranch();
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError(
        'not_a_pr',
        `gh could not resolve that pull request${
          error instanceof GhError && error.stderrTail !== '' ? `: ${error.stderrTail}` : ''
        }`,
      );
    }
  }

  async #sweep(repo: string): Promise<SweepResult | null> {
    if (!this.#deps.config.sweepEnabled) return null;
    try {
      return await (this.#deps.sweep ?? realSweep)(this.#deps.gh, {
        onlyRepo: repo,
        cacheDir: this.#deps.config.cacheDir,
        logger: this.#log,
      });
    } catch {
      this.#log('warn', 'sweep_failed', { repo });
      return null;
    }
  }

  #startedText(active: ActiveTracking, sweepResult: SweepResult | null, requiredChecks: readonly string[]): string {
    const lines = [
      `Tracking ${prKey(active.prRef)} — ${active.pr.url}`,
      `head: ${active.head.headSha ?? 'unknown'} (source: ${active.head.headSource ?? 'none'})`,
      `state: ${active.pr.isDraft ? 'draft' : 'open'} (${active.pr.headRefName} into ${active.pr.baseRefName})`,
      `hook: ${active.hookId}`,
      `listener: 127.0.0.1:${active.listener.port}`,
      `filters: ci_events=${active.ciEvents}, required_checks=[${requiredChecks.join(', ')}], comment_authors=${
        active.commentAuthors === null ? 'anyone' : [...active.commentAuthors].join(', ')
      }`,
      'Events before this moment were not captured and will not be replayed.',
    ];
    if (sweepResult !== null && sweepResult.failures.length > 0) {
      lines.push(
        `warning: the startup sweep could not delete ${sweepResult.failures.length} leftover hook(s); they are retried on the next track.`,
      );
    }
    return lines.join('\n');
  }
}

function resolveCommentAuthors(
  fromInput: readonly string[] | undefined,
  fromConfig: ReadonlySet<string> | null,
  login: string | null,
): ReadonlySet<string> | null {
  if (fromInput !== undefined) {
    const logins = fromInput.map((name) => name.trim().toLowerCase()).filter((name) => name.length > 0);
    return logins.length > 0 ? new Set(logins) : null;
  }
  if (fromConfig !== null) return fromConfig;
  // Acting on a comment means pushing code, so the default trusts only the account this
  // machine is authenticated as.
  return login === null || login === '' ? null : new Set([login.toLowerCase()]);
}

function forwarderLine(forwarder: Forwarder): string {
  const base =
    forwarder.state === 'restarting'
      ? `restarting (attempt ${forwarder.restarts}, next retry in ${Math.round((forwarder.nextRetryInMs ?? 0) / 1000)}s)`
      : forwarder.state;
  const tail = forwarder.lastStderrLine === null ? '' : ` — last gh line: ${forwarder.lastStderrLine}`;
  return `${base}, restarts so far: ${forwarder.restarts}${tail}`;
}

function countersLine(counters: Record<string, number>): string {
  return `counters: ${Object.entries(counters)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')}`;
}
