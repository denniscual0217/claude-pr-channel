import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'bun:test';

const root = join(import.meta.dir, '..');

// This repository is public. The employer's product and organisation names belonged to
// one company's setup, never to the plugin: the deploy workflow is configured by name and
// the fixtures use a neutral placeholder.
const BANNED = /temploy|toptal/i;

const SEARCHED = ['README.md', 'docs', 'skills', 'src', 'test', 'schema'];

// The guard names the terms it bans, so it is the one file that cannot be scanned.
const SELF = relative(root, import.meta.path);

function filesUnder(path: string): string[] {
  const full = join(root, path);
  if (!statSync(full).isDirectory()) return [path];
  return readdirSync(full).flatMap((entry) => filesUnder(join(path, entry)));
}

describe('the terms that identified one employer', () => {
  it('appear nowhere a reader of this repository would find them', () => {
    const offenders = SEARCHED.flatMap(filesUnder)
      .filter((path) => path !== SELF)
      .filter((path) => BANNED.test(readFileSync(join(root, path), 'utf8')));

    expect(offenders).toEqual([]);
  });
});
