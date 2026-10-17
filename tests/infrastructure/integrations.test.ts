import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Delivery } from '#application/contracts/integrations.ts';
import { GitHubSettingsChanges } from '#domain/integrations/github.ts';
import { MemoryDeliveryLog } from '#infrastructure/github/delivery-log.ts';
import { HmacSignatures } from '#infrastructure/github/hmac-signatures.ts';
import { GitHubPayloadReader } from '#infrastructure/github/payloads.ts';
import { FileGitHubIntegrationRepository, IntegrationsFile } from '#infrastructure/integrations/integrations-file.ts';

const NOW = new Date('2026-03-02T10:00:00.000Z');
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boards-integrations-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const file = () => path.join(dir, 'integrations.json');
const bytes = (text: string) => new TextEncoder().encode(text);

describe('integrations.json', () => {
  it('keeps the existing format, readable by the server only', async () => {
    const repo = new FileGitHubIntegrationRepository(new IntegrationsFile(dir));
    const integration = await repo.get();
    assert.equal(integration.hasSecret, false);
    integration.rotateSecret('s3cret', NOW);
    const changes = GitHubSettingsChanges.validate({ repositories: ['acme/boards'] });
    assert.ok(changes.ok);
    integration.update(changes.value, NOW);
    await repo.save(integration);
    assert.equal(fs.statSync(file()).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file(), 'utf8')), {
      github: { enabled: true, moveOnPullRequestOpened: true, completeOnMerge: true, repositories: ['acme/boards'], secret: 's3cret' },
    });
    // A server started later reads it back.
    const reread = await new FileGitHubIntegrationRepository(new IntegrationsFile(dir)).get();
    assert.equal(reread.webhookSecret, 's3cret');
    assert.deepEqual(reread.settings.repositories, ['acme/boards']);
  });

  it('fills in settings missing from older files', async () => {
    fs.writeFileSync(file(), JSON.stringify({ github: { secret: 'old', enabled: false } }));
    const integration = await new FileGitHubIntegrationRepository(new IntegrationsFile(dir)).get();
    assert.deepEqual(integration.settings, { enabled: false, moveOnPullRequestOpened: true, completeOnMerge: true, repositories: [] });
    assert.equal(integration.hasSecret, true);
  });

  it('refuses to start on a damaged file', () => {
    for (const damaged of ['[]', '{"github": 1}', '{"github": {"enabled": "false"}}', '{"github": {"repositories": "a/b"}}', '{"github": {"secret": 5}}']) {
      fs.writeFileSync(file(), damaged);
      assert.throws(() => new IntegrationsFile(dir), /integrations\.json is damaged/, damaged);
    }
  });
});

describe('webhook signatures', () => {
  it('match an HMAC-SHA256 of the exact body', () => {
    const signatures = new HmacSignatures();
    const body = bytes('{"zen":"hi"}');
    const sign = (secret: string, data: Uint8Array) => `sha256=${crypto.createHmac('sha256', secret).update(data).digest('hex')}`;
    assert.equal(signatures.matches('s3cret', body, sign('s3cret', body)), true);
    assert.equal(signatures.matches('s3cret', body, sign('other', body)), false);
    assert.equal(signatures.matches('s3cret', bytes('{"zen":"hi" }'), sign('s3cret', body)), false);
    assert.equal(signatures.matches('s3cret', body, 'sha256=00'), false);
    assert.equal(signatures.matches('s3cret', body, sign('s3cret', body).replace('sha256=', 'sha1=')), false);
    assert.equal(signatures.matches('', body, sign('', body)), false);
  });
});

describe('GitHub payloads', () => {
  const reader = new GitHubPayloadReader();
  const read = (event: string, payload: unknown) => reader.read(event, bytes(JSON.stringify(payload)));
  const repository = { full_name: 'acme/boards', html_url: 'https://github.com/acme/boards', default_branch: 'main' };
  const sender = { login: 'octocat' };

  it('translates pushes', () => {
    const result = read('push', {
      ref: 'refs/heads/wi/1',
      repository,
      sender,
      commits: [{ id: 'aaa', message: 'AB#1', url: 'u', author: { name: 'Octo Cat' }, timestamp: '2026-01-01T00:00:00Z' }],
    });
    assert.deepEqual(result, {
      ok: true,
      value: {
        repository: 'acme/boards',
        sender: 'octocat',
        activity: {
          kind: 'push',
          repository: { fullName: 'acme/boards', htmlUrl: 'https://github.com/acme/boards', defaultBranch: 'main' },
          ref: 'refs/heads/wi/1',
          deleted: false,
          commits: [{ sha: 'aaa', message: 'AB#1', url: 'u', author: 'Octo Cat', timestamp: '2026-01-01T00:00:00Z' }],
        },
      },
    });
  });

  it('translates branches, tags, pull requests and check suites', () => {
    const branch = read('delete', { ref: 'wi/1', ref_type: 'branch', repository });
    assert.ok(branch.ok);
    assert.deepEqual(branch.value.activity, { kind: 'branch', action: 'delete', ref: 'wi/1', repository: { fullName: 'acme/boards', htmlUrl: 'https://github.com/acme/boards', defaultBranch: 'main' } });
    assert.equal(branch.value.sender, null);
    const tag = read('create', { ref: 'v1', ref_type: 'tag' });
    assert.ok(tag.ok);
    assert.deepEqual(tag.value, { repository: '', sender: null, activity: { kind: 'otherRef', action: 'create', refType: 'tag' } });

    const pr = read('pull_request', {
      action: 'closed',
      repository,
      pull_request: { number: 5, title: 'T', body: null, html_url: 'h', state: 'closed', merged: false, merged_at: '2026-01-01T00:00:00Z', head: { ref: 'wi/1', sha: 'abc' }, base: { ref: 'main' } },
    });
    assert.ok(pr.ok);
    assert.equal(pr.value.activity.kind, 'pullRequest');
    if (pr.value.activity.kind === 'pullRequest') {
      assert.deepEqual(pr.value.activity.pullRequest, {
        number: 5,
        title: 'T',
        body: null,
        url: 'h',
        state: 'closed',
        merged: true,
        draft: false,
        author: null,
        headRef: 'wi/1',
        headSha: 'abc',
        baseRef: 'main',
        createdAt: null,
      });
    }
    const suite = read('check_suite', { check_suite: { head_sha: 'abc', status: 'completed', conclusion: 'success' } });
    assert.ok(suite.ok);
    assert.deepEqual(suite.value.activity, { kind: 'checkSuite', headSha: 'abc', status: 'completed', conclusion: 'success' });
    const ping = read('ping', { zen: 'hi', repository });
    assert.ok(ping.ok);
    assert.deepEqual(ping.value, { repository: 'acme/boards', sender: null, activity: { kind: 'ping' } });
    const other = read('issues', {});
    assert.ok(other.ok);
    assert.deepEqual(other.value.activity, { kind: 'other', event: 'issues' });
  });

  it('says what is wrong with a payload it cannot use', () => {
    assert.deepEqual(reader.read('push', bytes('not json')), { ok: false, error: { code: 'PAYLOAD_NOT_JSON' } });
    assert.deepEqual(read('push', [1]), { ok: false, error: { code: 'PAYLOAD_INVALID', event: 'push', reason: 'Expected a JSON object' } });
    assert.deepEqual(read('push', { ref: 'refs/heads/x' }), { ok: false, error: { code: 'PAYLOAD_INVALID', event: 'push', reason: 'repository: Expected an object' } });
    assert.deepEqual(read('push', { repository, commits: [{ id: 'a' }] }), {
      ok: false,
      error: { code: 'PAYLOAD_INVALID', event: 'push', reason: 'commits.0.message: Expected text' },
    });
    assert.deepEqual(read('pull_request', { action: 'opened', repository, pull_request: { number: 1, title: 'T', html_url: 'h', head: { ref: 'x' }, base: { ref: 'main' } } }), {
      ok: false,
      error: { code: 'PAYLOAD_INVALID', event: 'pull_request', reason: 'pull_request.head.sha: Expected text' },
    });
  });
});

describe('delivery log', () => {
  const delivery = (id: string): Delivery => ({ id, event: 'ping', repo: '', receivedAt: NOW.toISOString(), result: 'ok', linked: [1], ok: true });

  it('keeps the newest 50 deliveries, as copies', () => {
    const log = new MemoryDeliveryLog();
    for (let i = 0; i < 60; i++) log.record(delivery(`d${i}`));
    const recent = log.recent();
    assert.equal(recent.length, 50);
    assert.equal(recent[0]?.id, 'd59');
    recent[0]?.linked.push(2);
    assert.deepEqual(log.recent()[0]?.linked, [1]);
  });

  it('remembers the last 5000 handled delivery ids', () => {
    const log = new MemoryDeliveryLog();
    for (let i = 0; i < 5001; i++) log.markHandled(`d${i}`);
    assert.equal(log.wasHandled('d0'), false);
    assert.equal(log.wasHandled('d1'), true);
    assert.equal(log.wasHandled('d5000'), true);
  });
});
