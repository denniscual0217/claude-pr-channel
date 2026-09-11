// Test-only stand-in for the gh CLI. It answers from a JSON state file and records every
// call, so no test can reach GitHub. Without FAKE_GH_STATE it refuses to run at all:
// a test that forgot to configure it must fail loudly, never fall through to real gh.
import { createHmac, randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const statePath = process.env.FAKE_GH_STATE;
if (!statePath) {
  process.stderr.write('fake gh: FAKE_GH_STATE is not set\n');
  process.exit(99);
}

const args = process.argv.slice(2);
const logPath = process.env.FAKE_GH_LOG;
if (logPath) appendFileSync(logPath, `${JSON.stringify(args)}\n`);

function readState() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function out(value) {
  process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
  process.exit(0);
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const state = readState();
const joined = args.join(' ');

// gh webhook forward: creates a brand-new hook on the repository before it connects,
// leaves it there when it dies, and pings it through the caller's own listener. That
// ordering is the whole reason the channel has to reason about hooks it never confirmed.
if (args[0] === 'webhook' && args[1] === 'forward') {
  const flag = (name) => {
    const found = args.find((arg) => arg.startsWith(`--${name}=`));
    return found === undefined ? '' : found.slice(name.length + 3);
  };
  const repo = flag('repo');
  const id = Number(state.nextHookId ?? 100);
  state.nextHookId = id + 1;
  state.hooks = [...(state.hooks ?? []), { id, name: 'cli', active: true, created_at: new Date().toISOString() }];
  writeState(state);
  if (state.forwardConnects === false) await new Promise(() => {});
  process.stderr.write('Forwarding Webhook events from GitHub...\n');
  if (state.forwardPings !== false) {
    const body = JSON.stringify({ zen: 'Design for failure.', hook_id: id, repository: { full_name: repo } });
    await fetch(flag('url'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'ping',
        'X-GitHub-Delivery': randomUUID(),
        'X-Hub-Signature-256': `sha256=${createHmac('sha256', flag('secret')).update(body).digest('hex')}`,
      },
      body,
    }).catch(() => {});
  }
  await new Promise(() => {});
}

if (args[0] === 'auth' && args[1] === 'status') {
  if (state.unauthenticated) fail('gh: You are not logged into any GitHub hosts', 1);
  out('Logged in\n');
}

if (args[0] === 'extension' && args[1] === 'list') {
  out(state.webhookExtension === false ? '' : 'gh webhook\tcli/gh-webhook\tv1.0.0\n');
}

if (args[0] === 'api' && args[1] === 'user') {
  if (state.unauthenticated) fail('gh: HTTP 401', 1);
  out(`${state.login ?? 'octo-worker'}\n`);
}

if (args[0] === 'pr' && args[1] === 'view') {
  const pr = state.pr;
  if (!pr) fail('gh: no pull requests found for branch', 1);
  out(pr);
}

const hooksList = /^api repos\/(.+)\/hooks/.exec(joined);
const hookOne = /^api (?:-X (GET|DELETE|POST) )?repos\/(.+)\/hooks\/(\d+)(\/pings)?$/.exec(joined);

if (hookOne) {
  const [, method, repo, idText, pings] = hookOne;
  const id = Number(idText);
  state.hooks ??= [];
  const index = state.hooks.findIndex((hook) => hook.id === id);
  if (pings) {
    if (index === -1) fail('gh: HTTP 404: Not Found', 1);
    state.pinged = [...(state.pinged ?? []), id];
    writeState(state);
    out('');
  }
  if (method === 'DELETE') {
    if (state.deleteFails?.includes(id)) fail('gh: HTTP 403: Must have admin rights', 1);
    if (index === -1) fail('gh: HTTP 404: Not Found', 1);
    state.hooks.splice(index, 1);
    state.deleted = [...(state.deleted ?? []), id];
    writeState(state);
    out('');
  }
  if (index === -1) fail('gh: HTTP 404: Not Found', 1);
  out(state.hooks[index]);
}

if (hooksList) {
  out(state.hooks ?? []);
}

fail(`fake gh: unsupported invocation: ${joined}`, 97);
