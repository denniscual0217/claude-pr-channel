import { rmSync } from 'node:fs';
import { guardStdio, writeStderrLine } from '../log.js';
import { createGhClient } from './gh.js';
import { isSameProcess } from './ps.js';

// The backstop. gh webhook forward has no signal handling and never deletes the hook it
// created, and a SIGKILLed channel runs no handler of its own, so this process — a child
// of the channel with a pipe from it — is what still deletes the hook when the channel
// dies without warning.
//
// It is deliberately separate: a handler inside the channel cannot survive SIGKILL.

export interface JanitorState {
  repo: string;
  marker: string | null;
  hookId: number | null;
  // Hooks the channel created and failed to delete. They are ours by proof, so they are
  // deleted whatever else is on the repository.
  pendingDeletes: number[];
  // The repository's cli hooks immediately before gh was last launched. Anything newer
  // than this that gh left behind is a stray; see strayHook.
  snapshot: number[] | null;
  ghPid: number | null;
  ghStart: string | null;
}

export interface JanitorMessage {
  readonly repo?: string;
  readonly marker?: string;
  readonly hookId?: number | null;
  readonly pendingDeletes?: number[];
  readonly snapshot?: number[];
  readonly ghPid?: number | null;
  readonly ghStart?: string | null;
  readonly done?: boolean;
}

export const PPID_POLL_MS = 500;
const RETRY_SCHEDULE_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

export function applyMessage(state: JanitorState, message: JanitorMessage): void {
  if (typeof message.repo === 'string') state.repo = message.repo;
  if (typeof message.marker === 'string') state.marker = message.marker;
  if (message.hookId !== undefined) state.hookId = message.hookId;
  if (message.pendingDeletes !== undefined) state.pendingDeletes = [...message.pendingDeletes];
  if (message.snapshot !== undefined) state.snapshot = [...message.snapshot];
  if (message.ghPid !== undefined) state.ghPid = message.ghPid;
  if (message.ghStart !== undefined) state.ghStart = message.ghStart;
}

export interface CleanupDeps {
  readonly deleteHook: (repo: string, hookId: number) => Promise<unknown>;
  readonly listHooks: (repo: string) => Promise<readonly { id: number }[]>;
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  readonly sameProcess: (pid: number, start: string | null) => boolean;
  readonly wait: (ms: number) => Promise<void>;
  readonly removeMarker: (path: string) => void;
  readonly log: (event: string, fields?: Record<string, unknown>) => void;
}

export async function cleanup(state: JanitorState, deps: CleanupDeps): Promise<void> {
  // Kill gh first: a forwarder left running against a dead listener keeps the hook busy
  // and would recreate one on its own restart.
  if (state.ghPid !== null && deps.sameProcess(state.ghPid, state.ghStart)) {
    try {
      deps.kill(state.ghPid, 'SIGTERM');
      deps.log('janitor_killed_gh', { pid: state.ghPid });
    } catch {
      // Gone already.
    }
  }

  const ids = state.hookId === null ? await strayHook(state, deps) : [state.hookId];
  const pending = new Set([...ids, ...state.pendingDeletes]);
  for (let attempt = 0; pending.size > 0 && attempt <= RETRY_SCHEDULE_MS.length; attempt += 1) {
    if (attempt > 0) await deps.wait(RETRY_SCHEDULE_MS[attempt - 1] as number);
    for (const hookId of [...pending]) {
      try {
        await deps.deleteHook(state.repo, hookId);
        pending.delete(hookId);
        deps.log('janitor_deleted_hook', { repo: state.repo, hook_id: hookId });
      } catch {
        deps.log('janitor_delete_retry', { repo: state.repo, hook_id: hookId, attempt });
      }
    }
  }

  // The marker only goes when every hook it names is gone; otherwise the next sweep is
  // the last chance to clean it up.
  if (state.marker !== null && pending.size === 0) {
    deps.removeMarker(state.marker);
    deps.log('janitor_removed_marker', {});
  }
}

// The janitor has no listener, so it can never receive the signed ping that proves a hook
// is ours. It therefore deletes only what the channel confirmed and told it about. A hook
// gh created but nobody confirmed is left behind: leaking one is recoverable, and deleting
// the hook a live session is using for another PR in the same repo is not.
async function strayHook(state: JanitorState, deps: CleanupDeps): Promise<number[]> {
  if (state.hookId === null && state.pendingDeletes.length === 0) {
    deps.log('janitor_nothing_confirmed', { repo: state.repo });
  }
  return [];
}

async function main(): Promise<void> {
  guardStdio();
  const state: JanitorState = {
    repo: process.argv[2] ?? '',
    marker: null,
    hookId: null,
    pendingDeletes: [],
    snapshot: null,
    ghPid: null,
    ghStart: null,
  };
  const gh = createGhClient({ cwd: process.cwd() });
  const startingPpid = process.ppid;
  let finished = false;
  let doneSignalled = false;

  const log = (event: string, fields: Record<string, unknown> = {}): void => {
    writeStderrLine(`${JSON.stringify({ ts: new Date().toISOString(), component: 'janitor', event, ...fields })}\n`);
  };

  const finish = async (reason: string): Promise<void> => {
    if (finished) return;
    finished = true;
    clearInterval(ppidTimer);
    if (doneSignalled) {
      log('janitor_exit', { reason, acted: false });
      process.exit(0);
    }
    log('janitor_cleanup', { reason });
    await cleanup(state, {
      deleteHook: (repo, hookId) => gh.deleteHook(repo, hookId),
      listHooks: (repo) => gh.listCliHooks(repo),
      kill: (pid, signal) => process.kill(pid, signal),
      sameProcess: isSameProcess,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      removeMarker: (path) => rmSync(path, { force: true }),
      log,
    });
    log('janitor_exit', { reason, acted: true });
    process.exit(0);
  };

  // A terminal tear-down (tmux kill-session) delivers SIGHUP to the whole pane group and
  // Ctrl-C delivers SIGINT; neither may stop the janitor mid-cleanup. Its stdin closing
  // is the signal that the channel is gone.
  process.on('SIGHUP', () => log('janitor_signal_ignored', { signal: 'SIGHUP' }));
  process.on('SIGINT', () => log('janitor_signal_ignored', { signal: 'SIGINT' }));
  process.on('SIGTERM', () => void finish('sigterm'));

  // Reparenting to init is the only trace a SIGKILLed parent leaves once the pipe read
  // is already pending, so it is polled as well as watched.
  const ppidTimer = setInterval(() => {
    if (process.ppid !== startingPpid) void finish('reparented');
  }, PPID_POLL_MS);

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        try {
          const message = JSON.parse(line) as JanitorMessage;
          if (message.done === true) doneSignalled = true;
          else applyMessage(state, message);
        } catch {
          log('janitor_bad_message', {});
        }
      }
      index = buffer.indexOf('\n');
    }
  });
  process.stdin.on('end', () => void finish('stdin_end'));
  process.stdin.on('close', () => void finish('stdin_close'));
  process.stdin.resume();
}

if (import.meta.main) {
  void main();
}
