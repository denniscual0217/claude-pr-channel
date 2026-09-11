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
  // Set the moment tear-down begins. The restart callbacks are bound to the tracking they
  // were created for rather than to whatever is current, so a restart waking inside
  // listener.stop() cannot spawn a gh that the tear-down has already stopped watching.
  torn: boolean;
  // The repository's cli hooks as they were immediately before gh was last launched.
  // Mutable: gh creates a new hook on every launch, so what counts as new is re-measured
  // before each one.
  readonly snapshot: { ids: Set<number> };
  // Hooks this session created whose DELETE failed. Forgetting one orphans it: no marker,
  // no janitor and no sweep would ever name it again.
  readonly pendingDeletes: Set<number>;
  // Set only by proof: a ping signed with this session's secret, or a single new hook when
  // nothing else appeared. Never a hook that might be another session's.
  hookId: number | null;
  secret: WebhookSecret | null;
}

interface TeardownOutcome {
  readonly hookDeleted: boolean;
  readonly deleted: readonly number[];
  // New hooks this session could not prove are its own, so it left them alone.
  readonly leftBehind: readonly number[];
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
    janitor.send({ snapshot: [...snapshot.ids] });

    // Assigned once the tracking object exists; the restart callbacks hold this one,
    // not whatever happens to be current when they fire.
    let bound: ActiveTracking | null = null;

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
        if (active === null) return;
        for (const hookId of [...active.pendingDeletes]) await this.#deleteOrRemember(active, hookId);
        if (active.hookId !== null) {
          // A confirmed id leaves nothing to guess at: this session runs one gh at a time,
          // so once its own hook is deleted every other hook on the repository is someone
          // else's — including one another session created while we were tracking.
          await this.#deleteOrRemember(active, active.hookId);
        } else {
          // A launch that created a hook and then failed before connecting left it behind;
          // this is the last moment it can still be told apart from the next one.
          for (const hookId of (await this.#strayHooks(active)).ours) {
            await this.#deleteOrRemember(active, hookId);
          }
        }
        this.#pingedHookIds.clear();
        active.snapshot.ids = new Set((await this.#listHooks(active.prRef.repo)).map((hook) => hook.id));
        // Cleared id and fresh snapshot travel together: a janitor holding one without the
        // other would read another session's hook as the stray this launch left behind.
        active.hookId = null;
        active.marker.update({ hookId: null, pendingHookIds: [...active.pendingDeletes] });
        active.janitor.send({
          hookId: null,
          snapshot: [...active.snapshot.ids],
          pendingDeletes: [...active.pendingDeletes],
        });
      },
      onConnected: async () => {
        const active = this.#active;
        if (active === null) return;
        const rediscovered = await this.#discoverHookId(active.prRef.repo);
        active.hookId = rediscovered.hookId;
        const update = { hookId: rediscovered.hookId, ghPid: forwarder.pid, ghStart: forwarder.processStart };
        active.marker.update(update);
        active.janitor.send(update);
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
      torn: false,
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
      snapshot,
      pendingDeletes: new Set<number>(),
      hookId: null,
      secret,
    };
    bound = active;
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

    const discovered = await this.#discoverHookId(prRef.repo);

    // Delivery does not depend on knowing which hook is ours — the forwarder is connected
    // and events are already flowing. Only cleanup does. So an unconfirmed id is reported,
    // not fatal: refusing to track here would throw away a working channel over a webhook
    // we merely cannot name, and the alternative to naming it is guessing.
    if (discovered.hookId === null) {
      this.#log('warn', 'hook_unconfirmed', {
        pr: prKey(prRef),
        candidates: discovered.candidates,
        detail: 'no signed ping identified this session\'s webhook; it will be left in place on teardown',
      });
    }

    active.hookId = discovered.hookId;
    marker.update({ hookId: discovered.hookId });
    janitor.send({ hookId: discovered.hookId });
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

    const deleted =
      outcome.deleted.length > 0
        ? `Deleted webhook ${outcome.deleted.join(', ')}.`
        : 'There was no webhook of this session left to delete.';
    const lines = [
      outcome.hookDeleted
        ? `Stopped tracking ${prKey(active.prRef)}. ${deleted} Forwarder stopped.`
        : `Stopped tracking ${prKey(active.prRef)}. Forwarder and listener stopped, but webhook ${hookId ?? 'unknown'} could NOT be deleted; ` +
          'its marker is kept and the janitor is still retrying. The next track in this session sweeps it.',
      countersLine(counters),
    ];
    if (outcome.leftBehind.length > 0) {
      lines.splice(
        1,
        0,
        `Left in place: hook(s) ${outcome.leftBehind.join(', ')} appeared on ${active.prRef.repo} while this session was starting ` +
          'but could not be proved to be its own, so they may belong to another session. ' +
          `Check them with: gh api repos/${active.prRef.repo}/hooks`,
      );
    }
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
  async #teardown(active: ActiveTracking, options: { deleteHooks: boolean }): Promise<TeardownOutcome> {
    active.torn = true;
    if (this.#active === active) this.#active = null;
    await active.listener.stop();
    await active.forwarder.stop();

    let hookDeleted = true;
    let leftBehind: readonly number[] = [];
    const deleted: number[] = [];
    if (options.deleteHooks) {
      // With a confirmed id there is nothing to guess: this session runs one gh at a time,
      // so every other hook on the repo belongs to someone else. Without one, gh may still
      // have created a hook nothing ever confirmed — it is only safely ours when it is the
      // only one that appeared since the snapshot.
      const stray = active.hookId === null ? await this.#strayHooks(active) : { ours: [], ambiguous: [] };
      leftBehind = stray.ambiguous;
      const ids = new Set([
        ...(active.hookId === null ? [] : [active.hookId]),
        ...stray.ours,
        ...active.pendingDeletes,
      ]);
      for (const hookId of ids) {
        const gone = await this.#deleteOrRemember(active, hookId);
        if (gone) deleted.push(hookId);
        else hookDeleted = false;
      }
      if (leftBehind.length > 0) {
        this.#log('warn', 'hooks_left_behind', { repo: active.prRef.repo, ids: [...leftBehind] });
      }
    }

    if (hookDeleted) {
      active.marker.remove();
      // The janitor has nothing left to do, and says so before its pipe closes.
      active.janitor.send({ done: true });
    } else {
      // Whatever could not be deleted stays named, so the janitor and the next sweep both
      // still know what to retry.
      active.marker.update({ pendingHookIds: [...active.pendingDeletes] });
      active.janitor.send({ pendingDeletes: [...active.pendingDeletes] });
    }
    active.janitor.closeStdin();
    active.secret = null;
    active.requiredChecks.forget();
    this.#log('info', 'tracking_stopped', { pr: prKey(active.prRef), hook_deleted: hookDeleted });
    return { hookDeleted, deleted, leftBehind };
  }

  // Hooks that appeared since gh was last launched and that no signed ping claimed. gh
  // creates one on every launch and never deletes it, so an unconfirmed hook can still be
  // ours — but only when it is the only new one. Two or more and another session on this
  // repo may own one of them, and deleting that one stops its events without a trace, so
  // none is touched and the ids are reported instead.
  // Kept only so a tear-down can report what it is leaving behind. It never claims
  // ownership: without a signed ping there is no evidence a hook is ours, and on a repo
  // where another session is tracking a different PR the unfamiliar hook is usually theirs.
  async #strayHooks(active: ActiveTracking): Promise<{ ours: number[]; ambiguous: number[] }> {
    let listed: readonly { id: number }[];
    try {
      listed = await this.#listHooks(active.prRef.repo);
    } catch {
      return { ours: [], ambiguous: [] };
    }
    // The snapshot is fine to report from — it was only ever dangerous to delete from.
    // Naming a hook that predates this session would be a false accusation, not a leak.
    const unproven = listed
      .map((hook) => hook.id)
      .filter((id) => !this.#pingedHookIds.has(id) && !active.snapshot.ids.has(id));
    return { ours: [], ambiguous: unproven };
  }

  // A DELETE that failed is remembered rather than forgotten: the tear-down, the janitor
  // and the next sweep all retry what is left in pendingDeletes.
  async #deleteOrRemember(active: ActiveTracking, hookId: number): Promise<boolean> {
    const gone = await this.#deleteHookQuietly(active.prRef.repo, hookId);
    if (gone) active.pendingDeletes.delete(hookId);
    else active.pendingDeletes.add(hookId);
    return gone;
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

  // Ownership is proved, never guessed. Our webhook secret is unique to this session, so
  // a ping that reaches our listener with a valid signature can only be for our hook.
  // Anything else — a hook that appeared while we were starting, the only unfamiliar id
  // on the repo — is a guess, and every guess here risks deleting the hook another live
  // session is using for a different PR in the same repo.
  //
  // If GitHub's creation ping is missed (the relay is not always attached in time), we
  // ask GitHub to ping each of the repo's forwarding hooks: only ours comes back signed
  // with our secret. If none does, we own nothing and delete nothing — leaking a hook is
  // recoverable, deleting someone else's is not.
  async #discoverHookId(repo: string): Promise<{ hookId: number | null; candidates: readonly number[] }> {
    const deadline = this.#now().getTime() + (this.#deps.hookDiscoveryMs ?? 20_000);
    const pollMs = this.#deps.hookPollMs ?? 1_000;
    const seen = new Set<number>();
    const probed = new Set<number>();

    for (;;) {
      const confirmed = [...this.#pingedHookIds][0];
      if (confirmed !== undefined) return { hookId: confirmed, candidates: [...seen] };

      let listed: readonly { id: number }[] = [];
      try {
        listed = await this.#listHooks(repo);
      } catch {
        listed = [];
      }
      for (const hook of listed) seen.add(hook.id);

      for (const hookId of seen) {
        if (probed.has(hookId)) continue;
        probed.add(hookId);
        try {
          await this.#deps.gh.pingHook(repo, hookId);
        } catch {
          // A ping we cannot send just means this candidate stays unproven.
        }
      }

      const afterProbe = [...this.#pingedHookIds][0];
      if (afterProbe !== undefined) return { hookId: afterProbe, candidates: [...seen] };
      if (this.#now().getTime() >= deadline) break;
      await this.#wait(pollMs);
    }

    return { hookId: null, candidates: [...seen] };
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
      `hook: ${active.hookId ?? 'unconfirmed'}`,
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
