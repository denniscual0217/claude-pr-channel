import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../log.js';
import { noopLogger } from '../log.js';
import type { GhClient } from './gh.js';
import { isSameProcess, processInfo } from './ps.js';

export interface HookMarker {
  readonly repo: string;
  // Only a hook this session proved is its own is ever named here: the sweep deletes what
  // a marker names, and a hook that might belong to another live session must not be in it.
  hookId: number | null;
  // Hooks this session created and could not delete. They are kept here so the sweep
  // retries them: nothing else names them once the forwarder has moved on.
  pendingHookIds: number[];
  readonly sessionId: string | null;
  janitorPid: number | null;
  janitorStart: string | null;
  ghPid: number | null;
  ghStart: string | null;
  readonly createdAt: string;
}

export function markerDir(cacheDir?: string | null): string {
  if (cacheDir != null && cacheDir.trim() !== '') return join(cacheDir, 'hooks');
  const base = process.env['XDG_CACHE_HOME']?.trim() || join(homedir(), '.cache');
  return join(base, 'claude-pr-channel', 'hooks');
}

function markerName(repo: string, hookId: number | null, pendingId: string): string {
  const [owner = 'unknown', name = 'unknown'] = repo.split('/');
  return `${owner}__${name}__${hookId === null ? `pending-${pendingId}` : hookId}.json`;
}

export interface MarkerHandle {
  readonly path: string;
  readonly marker: HookMarker;
  update(
    changes: Partial<Pick<HookMarker, 'hookId' | 'pendingHookIds' | 'janitorPid' | 'janitorStart' | 'ghPid' | 'ghStart'>>,
  ): string;
  remove(): void;
}

// The marker exists from before gh starts until after the DELETE succeeds. It is the only
// durable thing this design keeps, and it is a ledger for cleanup, never a routing table.
export function writeMarker(
  init: { repo: string; sessionId: string | null; cacheDir?: string | null },
): MarkerHandle {
  const dir = markerDir(init.cacheDir);
  mkdirSync(dir, { recursive: true });
  const pendingId = randomUUID();
  const marker: HookMarker = {
    repo: init.repo,
    hookId: null,
    pendingHookIds: [],
    sessionId: init.sessionId,
    janitorPid: null,
    janitorStart: null,
    ghPid: null,
    ghStart: null,
    createdAt: new Date().toISOString(),
  };
  let path = join(dir, markerName(init.repo, null, pendingId));
  writeFileSync(path, JSON.stringify(marker), { mode: 0o600 });
  let removed = false;

  return {
    get path() {
      return path;
    },
    marker,
    update(changes) {
      // A late update from work still in flight must not resurrect a marker the tear-down
      // already removed: the file would name hooks nothing is tracking any more.
      if (removed) return path;
      Object.assign(marker, changes);
      const wanted = join(dir, markerName(marker.repo, marker.hookId, pendingId));
      writeFileSync(path, JSON.stringify(marker), { mode: 0o600 });
      if (wanted !== path) {
        renameSync(path, wanted);
        path = wanted;
      }
      return path;
    },
    remove() {
      removed = true;
      rmSync(path, { force: true });
    },
  };
}

export interface ReadMarker {
  readonly path: string;
  readonly marker: HookMarker;
}

export function readMarkers(cacheDir?: string | null): readonly ReadMarker[] {
  const dir = markerDir(cacheDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const found: ReadMarker[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    try {
      const marker = JSON.parse(readFileSync(path, 'utf8')) as HookMarker;
      if (typeof marker.repo === 'string' && marker.repo.includes('/')) found.push({ path, marker });
    } catch {
      // A marker we cannot read names no hook, so there is nothing to act on. Leave it.
    }
  }
  return found;
}

export function janitorAlive(marker: HookMarker): boolean {
  if (marker.janitorPid === null) return false;
  const info = processInfo(marker.janitorPid);
  if (info === null) return false;
  if (marker.janitorStart !== null && info.start !== marker.janitorStart) return false;
  // A pid reused by something unrelated must not read as a live janitor.
  return info.args.includes('janitor') && info.args.includes(marker.repo);
}

export interface SweepResult {
  readonly deletedHooks: readonly number[];
  readonly killedGh: readonly number[];
  readonly removedMarkers: number;
  readonly skippedLive: number;
  readonly failures: readonly { hookId: number; reason: string }[];
}

export interface SweepOptions {
  readonly onlyRepo?: string;
  readonly cacheDir?: string | null;
  readonly logger?: Logger;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
}

// Markers whose janitor is alive belong to a session still running; they are skipped.
// Hooks with no marker are never touched — that is what protects other machines, other
// sessions, and anything a person created by hand.
export async function sweep(gh: GhClient, options: SweepOptions = {}): Promise<SweepResult> {
  const log = options.logger ?? noopLogger;
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const deletedHooks: number[] = [];
  const killedGh: number[] = [];
  const failures: { hookId: number; reason: string }[] = [];
  let removedMarkers = 0;
  let skippedLive = 0;

  for (const { path, marker } of readMarkers(options.cacheDir)) {
    if (options.onlyRepo !== undefined && marker.repo !== options.onlyRepo) continue;
    if (janitorAlive(marker)) {
      skippedLive += 1;
      continue;
    }

    const pending = Array.isArray(marker.pendingHookIds) ? marker.pendingHookIds : [];
    const ids = new Set([...(marker.hookId === null ? [] : [marker.hookId]), ...pending]);
    let allGone = true;
    for (const hookId of ids) {
      try {
        await gh.deleteHook(marker.repo, hookId);
        deletedHooks.push(hookId);
      } catch (error) {
        allGone = false;
        failures.push({ hookId, reason: error instanceof Error ? error.name : 'unknown' });
        log('warn', 'sweep_delete_failed', { repo: marker.repo, hook_id: hookId });
      }
    }

    if (marker.ghPid !== null && isSameProcess(marker.ghPid, marker.ghStart)) {
      try {
        kill(marker.ghPid, 'SIGTERM');
        killedGh.push(marker.ghPid);
      } catch {
        // Already gone between the check and the signal; nothing to do.
      }
    }

    // A marker whose hook could not be deleted is kept so the next sweep tries again.
    if (allGone) {
      rmSync(path, { force: true });
      removedMarkers += 1;
    }
  }

  log('info', 'sweep_done', {
    deleted: deletedHooks.length,
    killed_gh: killedGh.length,
    removed_markers: removedMarkers,
    skipped_live: skippedLive,
    failures: failures.length,
  });
  return { deletedHooks, killedGh, removedMarkers, skippedLive, failures };
}
