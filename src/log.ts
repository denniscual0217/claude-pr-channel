export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type Logger = (level: LogLevel, event: string, fields?: Record<string, unknown>) => void;

let stdioBroken = false;

// Claude Code owns the other end of stdout and stderr. When the session goes, a write to
// the closed pipe raises an asynchronous 'error' on the stream, and an unhandled one is an
// uncaught exception: the process dies on its first log line, before any cleanup runs.
// That is how a webhook gets left on a repository, so logging must never be able to end
// this process. Call this before anything else writes.
export function guardStdio(): void {
  for (const stream of [process.stderr, process.stdout]) {
    stream.on('error', () => {
      stdioBroken = true;
    });
  }
}

export function writeStderrLine(line: string): void {
  if (stdioBroken) return;
  try {
    process.stderr.write(line);
  } catch {
    stdioBroken = true;
  }
}

// stderr is the only channel a stdio MCP server may write to. Identifiers, states and
// counts only: never a payload, a header value, or the webhook secret.
export function stderrLogger(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  writeStderrLine(`${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`);
}

export const noopLogger: Logger = () => {};
