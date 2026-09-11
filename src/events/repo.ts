import type { PrRef } from '../types.js';

export function normalizeRepo(repo: string): string {
  return repo.trim().toLowerCase();
}

const REPO_PATTERN = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

export function isRepoFullName(repo: string): boolean {
  return REPO_PATTERN.test(repo);
}

export class PrRefError extends Error {
  override readonly name = 'PrRefError';
}

// Accepts what a person would type at the tool: a bare number, owner/name#n, or the URL
// from the browser. repoOverride wins over whatever the input implies.
export function parsePrRef(input: string, repoOverride?: string | null): { ref: PrRef | null; repo: string | null } {
  const trimmed = input.trim();
  const override = repoOverride == null || repoOverride.trim() === '' ? null : normalizeRepo(repoOverride);
  if (override !== null && !isRepoFullName(override)) {
    throw new PrRefError(`repo "${repoOverride}" is not of the form owner/name`);
  }

  if (trimmed === '') return { ref: null, repo: override };

  if (/^#?\d+$/.test(trimmed)) {
    const prNumber = Number(trimmed.replace('#', ''));
    assertNumber(prNumber, trimmed);
    return override === null ? { ref: null, repo: null } : { ref: { repo: override, prNumber }, repo: override };
  }

  const shorthand = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(trimmed);
  if (shorthand) {
    const prNumber = Number(shorthand[2]);
    assertNumber(prNumber, trimmed);
    const repo = override ?? normalizeRepo(shorthand[1] as string);
    return { ref: { repo, prNumber }, repo };
  }

  const url = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(
    trimmed,
  );
  if (url) {
    const prNumber = Number(url[2]);
    assertNumber(prNumber, trimmed);
    const repo = override ?? normalizeRepo(url[1] as string);
    return { ref: { repo, prNumber }, repo };
  }

  throw new PrRefError(`"${input}" is not a PR number, owner/name#n, or a github.com pull request URL`);
}

function assertNumber(value: number, raw: string): void {
  if (!Number.isInteger(value) || value < 1) throw new PrRefError(`"${raw}" does not name a positive PR number`);
}
