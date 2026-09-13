import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GithubEventName, PrRef } from '../../src/types.js';

// Obviously fake and test-only. The real secret lives in GITHUB_WEBHOOK_SECRET at
// runtime and never appears in this repository.
export const TEST_WEBHOOK_SECRET = 'test-only-fake-secret';

export const FIXTURE_REPO = 'acme-labs/widget-service';
export const FIXTURE_PR: PrRef = { repo: FIXTURE_REPO, prNumber: 42 };
export const FIXTURE_HEAD_SHA = '4d0f1a2b3c4d5e6f70819a2b3c4d5e6f70819a2b';
export const FIXTURE_NEXT_HEAD_SHA = 'c3a91e5bd27f04186a5c9be31d70f4a2c8e6b510';
export const FIXTURE_REQUIRED_CHECKS = ['ci/lint', 'ci/test'] as const;
export const FIXTURE_DEPLOY_WORKFLOW = 'Build Preview Image';

export const FIXTURES = {
  prComment: { file: 'issue_comment.created.json', event: 'issue_comment' },
  prReview: { file: 'pull_request_review.submitted.json', event: 'pull_request_review' },
  prReviewComment: { file: 'pull_request_review_comment.created.json', event: 'pull_request_review_comment' },
  checkLintGreen: { file: 'check_run.completed.lint.json', event: 'check_run' },
  checkTestGreen: { file: 'check_run.completed.test.json', event: 'check_run' },
  checkTestFailed: { file: 'check_run.completed.test-failed.json', event: 'check_run' },
  workflowRun: { file: 'workflow_run.completed.deploy.json', event: 'workflow_run' },
  prSynchronize: { file: 'pull_request.synchronize.json', event: 'pull_request' },
  prMerged: { file: 'pull_request.closed.merged.json', event: 'pull_request' },
} as const satisfies Record<string, { file: string; event: GithubEventName }>;

export type FixtureName = keyof typeof FIXTURES;

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

export function loadFixture(name: FixtureName): Record<string, unknown> {
  const raw = readFileSync(join(FIXTURE_DIR, FIXTURES[name].file), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

export function fixtureEvent(name: FixtureName): GithubEventName {
  return FIXTURES[name].event;
}

export function signBody(rawBody: string | Buffer, secret: string = TEST_WEBHOOK_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export interface SignedDelivery {
  readonly body: string;
  readonly deliveryId: string;
  readonly eventName: GithubEventName;
  readonly headers: Record<string, string>;
}

export interface SignDeliveryOptions {
  readonly deliveryId?: string;
  readonly secret?: string;
  readonly signature?: string;
  readonly mutate?: (payload: Record<string, unknown>) => void;
}

export function signDelivery(name: FixtureName, options: SignDeliveryOptions = {}): SignedDelivery {
  const payload = loadFixture(name);
  options.mutate?.(payload);
  const body = JSON.stringify(payload);
  const deliveryId = options.deliveryId ?? randomUUID();
  const eventName = fixtureEvent(name);
  return {
    body,
    deliveryId,
    eventName,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'GitHub-Hookshot/fixture',
      'X-GitHub-Event': eventName,
      'X-GitHub-Delivery': deliveryId,
      'X-GitHub-Hook-Installation-Target-Type': 'repository',
      'X-Hub-Signature-256': options.signature ?? signBody(body, options.secret ?? TEST_WEBHOOK_SECRET),
    },
  };
}

export interface DeliveryResponse {
  readonly status: number;
  readonly body: string;
}

export async function postDelivery(baseUrl: string, delivery: SignedDelivery): Promise<DeliveryResponse> {
  const response = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: delivery.headers,
    body: delivery.body,
  });
  return { status: response.status, body: await response.text() };
}

export function setHeadSha(payload: Record<string, unknown>, headSha: string): void {
  const checkRun = payload['check_run'] as { head_sha?: string } | undefined;
  const workflowRun = payload['workflow_run'] as { head_sha?: string } | undefined;
  const pullRequest = payload['pull_request'] as { head?: { sha?: string } } | undefined;
  if (checkRun) checkRun.head_sha = headSha;
  if (workflowRun) workflowRun.head_sha = headSha;
  if (pullRequest?.head) pullRequest.head.sha = headSha;
}
