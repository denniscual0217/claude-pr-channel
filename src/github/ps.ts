import { execFileSync } from 'node:child_process';

export interface ProcessInfo {
  readonly pid: number;
  readonly args: string;
  readonly start: string;
}

// pid alone is not identity: pids are reused, and killing the wrong process is worse
// than leaving a hook behind. Every check pairs the pid with the start time recorded
// when we spawned it.
export function processInfo(pid: number): ProcessInfo | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=,args=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = out.split('\n').find((candidate) => candidate.trim().length > 0);
    if (line === undefined) return null;
    // lstart is a fixed 24-character ctime string ("Mon Sep  7 10:00:00 2026").
    return { pid, start: line.slice(0, 24).trim(), args: line.slice(24).trim() };
  } catch {
    return null;
  }
}

export function isSameProcess(pid: number, expectedStart: string | null): boolean {
  const info = processInfo(pid);
  if (info === null) return false;
  return expectedStart === null || info.start === expectedStart;
}

export function processStart(pid: number): string | null {
  return processInfo(pid)?.start ?? null;
}
