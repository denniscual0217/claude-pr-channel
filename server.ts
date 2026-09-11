import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { join } from 'node:path';
import { loadConfig } from './src/config.js';
import { createPrChannelServer, watchClientDisconnect } from './src/channel/server.js';
import { Tracking, ToolError, type JanitorHandle, type TrackInput } from './src/channel/tracking.js';
import { createGhClient } from './src/github/gh.js';
import { spawnGhForwarder } from './src/github/forwarder.js';
import { processStart } from './src/github/ps.js';
import { stderrLogger } from './src/log.js';

const config = loadConfig(process.env);
const sessionId = process.env['CLAUDE_CODE_SESSION_ID'] ?? null;
const projectDir = process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();

const server = createPrChannelServer();
const gh = createGhClient({ cwd: projectDir });

const tracking = new Tracking({
  gh,
  config,
  notifier: server,
  sessionId,
  projectDir,
  spawnForwarder: spawnGhForwarder(projectDir),
  spawnJanitor: (repo) => spawnJanitor(repo, projectDir),
  logger: stderrLogger,
  processStart,
});

const TOOLS = [
  {
    name: 'track',
    description:
      'Start delivering this GitHub pull request\'s events into this session. One PR per session. ' +
      'Blocks until the webhook is confirmed, so a success means events are flowing. Events from before this call are not replayed.',
    inputSchema: {
      type: 'object',
      properties: {
        pr: {
          type: 'string',
          description: 'PR number, "owner/name#n", or a github.com pull request URL. Omitted: the PR for the current branch.',
        },
        repo: { type: 'string', description: 'owner/name; wins over the repo implied by pr or the current checkout.' },
        ci_events: { type: 'string', enum: ['completed', 'failures', 'all'], description: 'Which CI transitions wake the session.' },
        required_checks: { type: 'array', items: { type: 'string' }, description: 'Check names that make up "all required green".' },
        comment_authors: { type: 'array', items: { type: 'string' }, description: 'Logins whose comments may reach the session.' },
        bot_comments: { type: 'string', enum: ['handle', 'ignore'] },
        replace: { type: 'boolean', description: 'Stop the PR this session currently tracks first.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'untrack',
    description: 'Stop tracking, delete the webhook this session created, and report the delivery counters.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'status',
    description: 'Report what this session is tracking, whether the forwarder is alive, and the delivery counters.',
    inputSchema: {
      type: 'object',
      properties: { verify: { type: 'boolean', description: 'Also ask GitHub whether the hook still exists.' } },
      additionalProperties: false,
    },
  },
] as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  try {
    switch (request.params.name) {
      case 'track':
        return ok(await tracking.track(args as TrackInput));
      case 'untrack':
        return ok(await tracking.untrack());
      case 'status':
        return ok(await tracking.status(args['verify'] === true));
      default:
        return fail('unknown_tool', `no tool named ${request.params.name}`);
    }
  } catch (error) {
    if (error instanceof ToolError) return fail(error.code, error.message);
    stderrLogger('error', 'tool_failed', { tool: request.params.name, error: error instanceof Error ? error.name : 'unknown' });
    return fail('internal_error', error instanceof Error ? error.message : 'unknown failure');
  }
});

function ok(text: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text }] };
}

// The first line is `code: message` so the skill can branch on the code without parsing prose.
function fail(code: string, message: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: `${code}: ${message}` }], isError: true };
}

function spawnJanitor(repo: string, cwd: string): JanitorHandle {
  const script = join(import.meta.dir, 'src', 'github', 'janitor.ts');
  const child = Bun.spawn(['bun', script, repo], { cwd, stdin: 'pipe', stdout: 'ignore', stderr: 'inherit' });
  const stdin = child.stdin;
  let open = true;
  return {
    pid: child.pid,
    processStart: processStart(child.pid),
    send: (message) => {
      if (!open) return;
      try {
        stdin.write(`${JSON.stringify(message)}\n`);
        stdin.flush();
      } catch {
        open = false;
      }
    },
    closeStdin: () => {
      if (!open) return;
      open = false;
      try {
        stdin.end();
      } catch {
        // The janitor already went; its own EOF handling covers the cleanup.
      }
    },
  };
}

let shuttingDown = false;

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  stderrLogger('info', 'shutdown', { reason });
  try {
    await tracking.shutdown();
  } catch (error) {
    stderrLogger('error', 'shutdown_failed', { error: error instanceof Error ? error.name : 'unknown' });
  }
  process.exit(0);
}

// StdioServerTransport never reports EOF, so the client going away has to be watched for
// directly; without this the channel outlives its session and its webhook with it.
watchClientDisconnect(process.stdin, () => void shutdown('stdin_closed'));
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => void shutdown(signal));
}

await server.connect(new StdioServerTransport());
stderrLogger('info', 'channel_ready', { session_id: sessionId, project_dir: projectDir });
