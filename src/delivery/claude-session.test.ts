import { describe, expect, it } from 'vitest';
import { ALLOWED_TOOLS_ENV, DEFAULT_ALLOWED_TOOLS, PERMISSION_MODE_ENV, claudeArgs } from './claude-session.js';

const target = { sessionId: 's1', workerDir: '/checkout' };

describe('claudeArgs', () => {
  it('resumes the session and passes the prompt as one argument', () => {
    const args = claudeArgs(target, 'do the thing', { env: {} });

    expect(args.slice(0, 4)).toEqual(['--resume', 's1', '-p', 'do the thing']);
  });

  // acceptEdits alone blocks Bash, so the session can edit files but cannot reply on the
  // PR or push. The allowlist is what makes it able to respond.
  it('allows gh and git without opening a general shell', () => {
    const args = claudeArgs(target, 'x', { env: {} });

    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(args).toContain('Bash(gh *)');
    expect(args).toContain('Bash(git *)');
    // The project's runner ships by default so a new repo needs no tool config.
    expect(args).toContain('Bash(npm *)');
    expect(args).not.toContain('bypassPermissions');
    expect(DEFAULT_ALLOWED_TOOLS).not.toContain('Bash');
  });

  it('takes the tool allowlist and mode from the environment', () => {
    const args = claudeArgs(target, 'x', {
      env: { [ALLOWED_TOOLS_ENV]: 'Bash(gh *), Bash(npm test)', [PERMISSION_MODE_ENV]: 'auto' },
    });

    expect(args[args.indexOf('--permission-mode') + 1]).toBe('auto');
    expect(args).toContain('Bash(npm test)');
    expect(args).not.toContain('Bash(git *)');
  });
});
