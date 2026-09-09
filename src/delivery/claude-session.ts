import { spawn } from 'node:child_process';
import type { DeliveryTarget, SendToSession } from './courier.js';

export const PERMISSION_MODE_ENV = 'PR_CHANNEL_PERMISSION_MODE';
export const ALLOWED_TOOLS_ENV = 'PR_CHANNEL_ALLOWED_TOOLS';

// Enough to answer a review, run the project's tests, and push a fix — and nothing
// else. Untrusted comment text reaches this session, so a broader mode
// (bypassPermissions) would hand whoever can comment on the PR an arbitrary shell.
// Override with PR_CHANNEL_ALLOWED_TOOLS for a repo that needs something else.
export const DEFAULT_ALLOWED_TOOLS = [
  'Bash(gh *)',
  'Bash(git *)',
  // The project's own runner, so the session can verify a fix before claiming it passes.
  // Broad enough to cover most repos without per-repo config, narrow enough that a
  // comment cannot become an arbitrary shell.
  'Bash(npm *)',
  'Bash(npx *)',
  'Bash(yarn *)',
  'Bash(pnpm *)',
  'Bash(node *)',
  'Bash(make *)',
] as const;
const DEFAULT_PERMISSION_MODE = 'acceptEdits';

export interface ClaudeSenderOptions {
  readonly command?: string;
  readonly permissionMode?: string;
  readonly allowedTools?: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export class SendFailedError extends Error {}

function splitTools(raw: string | undefined): readonly string[] | null {
  if (raw === undefined) return null;
  const tools = raw.split(',').map((tool) => tool.trim()).filter((tool) => tool.length > 0);
  return tools.length > 0 ? tools : null;
}

export function claudeArgs(
  target: DeliveryTarget,
  prompt: string,
  options: ClaudeSenderOptions = {},
): string[] {
  const env = options.env ?? process.env;
  const permissionMode =
    options.permissionMode ?? env[PERMISSION_MODE_ENV] ?? DEFAULT_PERMISSION_MODE;
  const allowedTools =
    options.allowedTools ?? splitTools(env[ALLOWED_TOOLS_ENV]) ?? DEFAULT_ALLOWED_TOOLS;

  return [
    '--resume',
    target.sessionId,
    '-p',
    prompt,
    '--permission-mode',
    permissionMode,
    ...(allowedTools.length > 0 ? ['--allowedTools', ...allowedTools] : []),
  ];
}

// `claude --resume <id> -p <text>` appends a turn to an existing session and runs it to
// completion. That is the whole delivery mechanism: the session never has to ask.
export function claudeSessionSender(options: ClaudeSenderOptions = {}): SendToSession {
  const command = options.command ?? 'claude';
  const timeoutMs = options.timeoutMs ?? 900_000;

  return (target, prompt) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(command, claudeArgs(target, prompt, options), {
        cwd: target.workerDir ?? options.cwd,
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
      timer.unref();

      child.stderr?.setEncoding('utf8');
      child.stderr?.resume();

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new SendFailedError(`could not run ${command}: ${error.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        // stderr can quote the untrusted prompt back, so only the exit code is reported.
        reject(new SendFailedError(`${command} exited ${code ?? 'on a signal'} for session ${target.sessionId}`));
      });
    });
}
