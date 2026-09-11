export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type Logger = (level: LogLevel, event: string, fields?: Record<string, unknown>) => void;

// stderr is the only channel a stdio MCP server may write to. Identifiers, states and
// counts only: never a payload, a header value, or the webhook secret.
export function stderrLogger(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`);
}

export const noopLogger: Logger = () => {};
