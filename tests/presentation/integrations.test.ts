import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Caller } from '#application/caller.ts';
import type { GitHubAdminView } from '#application/contracts/integrations.ts';
import type { WebhookError } from '#application/integrations/deps.ts';
import type { WorkItemError } from '#domain/work-items/errors.ts';
import type { DeliveryOutcome, ReceiveGitHubDeliveryInput } from '#application/integrations/receive-github-delivery.ts';
import { DEFAULT_GITHUB_SETTINGS } from '#domain/integrations/github.ts';
import { httpFailure } from '#presentation/http/errors.ts';
import { parseGitHubSettings } from '#presentation/integrations/parsers.ts';
import { WEBHOOK_LIMIT_BYTES, integrationRoutes, type IntegrationRouteDeps } from '#presentation/integrations/routes.ts';
import { err, ok, type Result } from '#shared/result.ts';

let caller: Caller = { name: 'Ann', memberId: 'm1', mayModerateComments: false, admin: 'granted', origin: undefined };
const view: GitHubAdminView = { settings: { ...DEFAULT_GITHUB_SETTINGS, repositories: [] }, hasSecret: true, webhookPath: '/api/integrations/github/webhook', deliveries: [] };
let open = true;
let outcome: Result<DeliveryOutcome, WebhookError | WorkItemError> = ok({ result: 'Ping received', linked: [] });
let calls: { name: string; input: unknown }[] = [];

const fakes: IntegrationRouteDeps = {
  identify: () => caller,
  getWebhookStatus: { execute: async () => ({ open }) },
  receiveGitHubDelivery: {
    execute: async (input: ReceiveGitHubDeliveryInput) => {
      calls.push({ name: 'receive', input: { ...input, body: new TextDecoder().decode(input.body) } });
      return outcome;
    },
  },
  getGitHubAdminView: {
    execute: async (input) => {
      calls.push({ name: 'view', input });
      return ok(view);
    },
  },
  updateGitHubSettings: {
    execute: async (input) => {
      calls.push({ name: 'update', input });
      return ok(view);
    },
  },
  rotateWebhookSecret: {
    execute: async (input) => {
      calls.push({ name: 'rotate', input });
      return ok({ secret: 'new', view });
    },
  },
};

const routes = integrationRoutes(fakes);
let server: http.Server;
let base: string;

before(async () => {
  server = http.createServer((req, res) => {
    void routes.handle(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end('not mine');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  calls = [];
  open = true;
  outcome = ok({ result: 'Ping received', linked: [] });
  caller = { ...caller, admin: 'granted' };
});

async function call(method: string, path: string, options: { body?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: options.headers ?? {}, ...(options.body === undefined ? {} : { body: options.body }) });
  const text = await res.text();
  return { status: res.status, body: text.startsWith('{') ? JSON.parse(text) : text };
}

const signed = { 'X-GitHub-Event': 'ping', 'X-Hub-Signature-256': 'sha256=abc', 'X-GitHub-Delivery': 'd1' };
const webhook = (headers: Record<string, string>, body = '{"zen":"hi"}') => call('POST', '/integrations/github/webhook', { headers, body });

describe('the webhook', () => {
  it('hands the raw body and headers to the use case, whatever the content type', async () => {
    assert.deepEqual(await webhook({ ...signed, 'Content-Type': 'application/x-www-form-urlencoded' }, 'payload=%7B%7D'), {
      status: 200,
      body: { result: 'Ping received', linked: [] },
    });
    assert.deepEqual(calls, [{ name: 'receive', input: { deliveryId: 'd1', event: 'ping', signature: 'sha256=abc', body: 'payload=%7B%7D' } }]);
    calls = [];
    const { 'X-GitHub-Delivery': _id, ...withoutId } = signed;
    await webhook(withoutId);
    assert.deepEqual(calls.map((c) => c.input), [{ deliveryId: null, event: 'ping', signature: 'sha256=abc', body: '{"zen":"hi"}' }]);
  });

  it('turns away what cannot be a delivery before reading the body', async () => {
    assert.deepEqual(await webhook({ 'X-GitHub-Event': 'ping' }), { status: 401, body: { error: 'Invalid signature' } });
    assert.deepEqual(await webhook({ 'X-GitHub-Event': 'ping', 'X-Hub-Signature-256': 'sha1=abc' }), { status: 401, body: { error: 'Invalid signature' } });
    assert.deepEqual(await webhook({ 'X-Hub-Signature-256': 'sha256=abc' }), { status: 400, body: { error: 'Missing X-GitHub-Event header' } });
    open = false;
    assert.deepEqual(await webhook(signed), { status: 404, body: { error: 'Webhook not found' } });
    assert.deepEqual(calls, []);
  });

  it('refuses bodies over the limit', async () => {
    assert.deepEqual(await webhook(signed, 'x'.repeat(WEBHOOK_LIMIT_BYTES + 1)), { status: 413, body: { error: 'Request is too large' } });
    assert.deepEqual(calls, []);
  });

  it('answers with the use case error', async () => {
    outcome = err({ code: 'INVALID_SIGNATURE' });
    assert.deepEqual(await webhook(signed), { status: 401, body: { error: 'Invalid signature' } });
    outcome = err({ code: 'PAYLOAD_INVALID', event: 'push', reason: 'repository: Expected an object' });
    assert.deepEqual(await webhook(signed), { status: 400, body: { error: 'Unexpected "push" payload: repository: Expected an object' } });
  });
});

describe('integration settings', () => {
  it('routes each endpoint to its use case', async () => {
    assert.deepEqual(await call('GET', '/integrations/github'), { status: 200, body: view });
    const json = { 'Content-Type': 'application/json' };
    assert.equal((await call('PUT', '/integrations/github', { headers: json, body: '{"enabled":false,"repositories":["a/b"]}' })).status, 200);
    assert.deepEqual(await call('POST', '/integrations/github/secret'), { status: 200, body: { secret: 'new', view } });
    assert.deepEqual(calls, [
      { name: 'view', input: { caller } },
      { name: 'update', input: { caller, enabled: false, moveOnPullRequestOpened: undefined, completeOnMerge: undefined, repositories: ['a/b'] } },
      { name: 'rotate', input: { caller } },
    ]);
  });

  it('turns away non-administrators before reading what they sent', async () => {
    caller = { ...caller, admin: 'token' };
    const malformed = await call('PUT', '/integrations/github', { headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.deepEqual(malformed, { status: 403, body: { error: "API tokens can't be used to administer the project" } });
    caller = { ...caller, admin: 'not-admin' };
    assert.equal((await call('GET', '/integrations/github')).status, 403);
    assert.equal((await call('POST', '/integrations/github/secret')).status, 403);
    assert.deepEqual(calls, []);
  });

  it('parses the settings body strictly', () => {
    assert.deepEqual(parseGitHubSettings({ bogus: 1 }), { ok: false, error: { code: 'INVALID_REQUEST', message: 'Unrecognized field "bogus"' } });
    assert.deepEqual(parseGitHubSettings({ enabled: 'yes' }), { ok: false, error: { code: 'INVALID_REQUEST', message: 'enabled: Expected true or false' } });
    assert.deepEqual(parseGitHubSettings({ repositories: [1] }), { ok: false, error: { code: 'INVALID_REQUEST', message: 'repositories.0: Expected text' } });
    assert.equal(parseGitHubSettings(undefined).ok, false);
  });
});

describe('integration errors', () => {
  it('have statuses and readable messages', () => {
    assert.deepEqual(httpFailure({ code: 'REPOSITORY_INVALID', value: 'nope' }), { status: 400, message: 'Repositories must look like owner/name ("nope" doesn\'t)' });
    assert.deepEqual(httpFailure({ code: 'TOO_MANY_REPOSITORIES', max: 50 }), { status: 400, message: 'At most 50 repositories can be listed' });
    assert.deepEqual(httpFailure({ code: 'WEBHOOK_CLOSED' }), { status: 404, message: 'Webhook not found' });
    assert.deepEqual(httpFailure({ code: 'PAYLOAD_NOT_JSON' }), { status: 400, message: 'Payload must be JSON (set the webhook content type to application/json)' });
    assert.deepEqual(httpFailure({ code: 'DEV_LINK_NOT_FOUND', id: 'x' }), { status: 404, message: 'Link not found' });
  });
});
