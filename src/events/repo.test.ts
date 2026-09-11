import { describe, expect, it } from 'bun:test';
import { PrRefError, normalizeRepo, parsePrRef } from './repo.js';

describe('normalizeRepo', () => {
  it('lowercases and trims, because GitHub compares repos case-insensitively', () => {
    expect(normalizeRepo('  Toptal/Some-Repo ')).toBe('toptal/some-repo');
  });
});

describe('parsePrRef', () => {
  it('reads a bare number against the repo override, and defers without one', () => {
    expect(parsePrRef('3053', 'Toptal/Example')).toEqual({
      ref: { repo: 'toptal/example', prNumber: 3053 },
      repo: 'toptal/example',
    });
    expect(parsePrRef('#3053')).toEqual({ ref: null, repo: null });
  });

  it('reads owner/name#n and a github.com URL', () => {
    expect(parsePrRef('Toptal/Example#7').ref).toEqual({ repo: 'toptal/example', prNumber: 7 });
    expect(parsePrRef('https://github.com/Toptal/Example/pull/7').ref).toEqual({
      repo: 'toptal/example',
      prNumber: 7,
    });
    expect(parsePrRef('https://github.com/toptal/example/pull/7/files').ref).toEqual({
      repo: 'toptal/example',
      prNumber: 7,
    });
  });

  it('lets an explicit repo win over the one the input implies', () => {
    expect(parsePrRef('https://github.com/toptal/example/pull/7', 'toptal/fork').ref).toEqual({
      repo: 'toptal/fork',
      prNumber: 7,
    });
  });

  it('defers to the current branch when nothing is given', () => {
    expect(parsePrRef('')).toEqual({ ref: null, repo: null });
    expect(parsePrRef('  ', 'toptal/example')).toEqual({ ref: null, repo: 'toptal/example' });
  });

  it('refuses what it cannot read rather than guessing', () => {
    expect(() => parsePrRef('not a pr')).toThrow(PrRefError);
    expect(() => parsePrRef('https://gitlab.com/toptal/example/pull/7')).toThrow(PrRefError);
    expect(() => parsePrRef('toptal/example#0')).toThrow(/positive/);
    expect(() => parsePrRef('7', 'not-a-repo')).toThrow(/owner\/name/);
  });
});
