import { describe, expect, it } from 'bun:test';
import { PrRefError, normalizeRepo, parsePrRef } from './repo.js';

describe('normalizeRepo', () => {
  it('lowercases and trims, because GitHub compares repos case-insensitively', () => {
    expect(normalizeRepo('  Acme-Labs/Some-Repo ')).toBe('acme-labs/some-repo');
  });
});

describe('parsePrRef', () => {
  it('reads a bare number against the repo override, and defers without one', () => {
    expect(parsePrRef('3053', 'Acme-Labs/Example')).toEqual({
      ref: { repo: 'acme-labs/example', prNumber: 3053 },
      repo: 'acme-labs/example',
    });
    expect(parsePrRef('#3053')).toEqual({ ref: null, repo: null });
  });

  it('reads owner/name#n and a github.com URL', () => {
    expect(parsePrRef('Acme-Labs/Example#7').ref).toEqual({ repo: 'acme-labs/example', prNumber: 7 });
    expect(parsePrRef('https://github.com/Acme-Labs/Example/pull/7').ref).toEqual({
      repo: 'acme-labs/example',
      prNumber: 7,
    });
    expect(parsePrRef('https://github.com/acme-labs/example/pull/7/files').ref).toEqual({
      repo: 'acme-labs/example',
      prNumber: 7,
    });
  });

  it('lets an explicit repo win over the one the input implies', () => {
    expect(parsePrRef('https://github.com/acme-labs/example/pull/7', 'acme-labs/fork').ref).toEqual({
      repo: 'acme-labs/fork',
      prNumber: 7,
    });
  });

  it('defers to the current branch when nothing is given', () => {
    expect(parsePrRef('')).toEqual({ ref: null, repo: null });
    expect(parsePrRef('  ', 'acme-labs/example')).toEqual({ ref: null, repo: 'acme-labs/example' });
  });

  it('refuses what it cannot read rather than guessing', () => {
    expect(() => parsePrRef('not a pr')).toThrow(PrRefError);
    expect(() => parsePrRef('https://gitlab.com/acme-labs/example/pull/7')).toThrow(PrRefError);
    expect(() => parsePrRef('acme-labs/example#0')).toThrow(/positive/);
    expect(() => parsePrRef('7', 'not-a-repo')).toThrow(/owner\/name/);
  });
});
