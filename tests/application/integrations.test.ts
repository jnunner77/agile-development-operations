import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GetGitHubAdminView } from '#application/integrations/get-github-admin-view.ts';
import { GetWebhookStatus } from '#application/integrations/get-webhook-status.ts';
import { ReceiveGitHubDelivery } from '#application/integrations/receive-github-delivery.ts';
import { RotateWebhookSecret } from '#application/integrations/rotate-webhook-secret.ts';
import { UpdateGitHubSettings } from '#application/integrations/update-github-settings.ts';
import { RemoveDevLink } from '#application/work-items/remove-dev-link.ts';
import type { DevelopmentActivity, PullRequest, SourceRepository } from '#domain/dev-links/activity.ts';
import { admin, ann, bo, setup, tokenCaller, unwrap } from './fixtures.ts';

const REPO: SourceRepository = { fullName: 'acme/boards', htmlUrl: 'https://github.com/acme/boards', defaultBranch: 'main' };

const pr = (fields: Partial<PullRequest> = {}): PullRequest => ({
  number: 5,
  title: 'Add login',
  body: null,
  url: 'https://github.com/acme/boards/pull/5',
  state: 'open',
  merged: false,
  draft: false,
  author: 'octocat',
  headRef: 'feature/x',
  headSha: 'abc123',
  baseRef: 'main',
  createdAt: null,
  ...fields,
});

/** A test app with a webhook secret, and a way to send it deliveries. */
async function connected() {
  const t = setup();
  const { secret } = unwrap(await new RotateWebhookSecret(t.deps).execute({ caller: admin }));
  const receive = new ReceiveGitHubDelivery(t.deps);
  let n = 0;
  const deliver = (activity: DevelopmentActivity, options: { id?: string | null; repository?: string; signature?: string; event?: string } = {}) => {
    const body = `payload-${++n}`;
    t.payloads.set(body, { repository: options.repository ?? REPO.fullName, sender: 'octocat', activity });
    return receive.execute({
      deliveryId: options.id === undefined ? `d-${n}` : options.id,
      event: options.event ?? activity.kind,
      signature: options.signature ?? `signed:${secret}`,
      body: new TextEncoder().encode(body),
    });
  };
  return { ...t, secret, deliver };
}

describe('receiving GitHub deliveries', () => {
  it('needs a secret, the webhook turned on, and a valid signature', async () => {
    const t = setup();
    const receive = new ReceiveGitHubDelivery(t.deps);
    const input = { deliveryId: 'd1', event: 'ping', signature: 'signed:none', body: new Uint8Array() };
    assert.equal((await new GetWebhookStatus(t.deps).execute()).open, false);
    assert.deepEqual(await receive.execute(input), { ok: false, error: { code: 'WEBHOOK_CLOSED' } });

    const c = await connected();
    assert.equal((await new GetWebhookStatus(c.deps).execute()).open, true);
    assert.deepEqual(await c.deliver({ kind: 'ping' }, { signature: 'signed:wrong' }), { ok: false, error: { code: 'INVALID_SIGNATURE' } });
    assert.equal((await c.deliver({ kind: 'ping' })).ok, true);
    unwrap(await new UpdateGitHubSettings(c.deps).execute({ caller: admin, enabled: false }));
    assert.equal((await new GetWebhookStatus(c.deps).execute()).open, false);
    assert.deepEqual(await c.deliver({ kind: 'ping' }), { ok: false, error: { code: 'WEBHOOK_CLOSED' } });
  });

  it('turns away unreadable payloads', async () => {
    const c = await connected();
    const receive = new ReceiveGitHubDelivery(c.deps);
    const result = await receive.execute({ deliveryId: 'x', event: 'push', signature: `signed:${c.secret}`, body: new TextEncoder().encode('unknown') });
    assert.deepEqual(result, { ok: false, error: { code: 'PAYLOAD_NOT_JSON' } });
  });

  it('links branches and commits from pushes, as GitHub, in one unit of work', async () => {
    const c = await connected();
    const pbi = await c.create('Product Backlog Item');
    const task = await c.create('Task');
    const before = c.unitOfWork.runs.length;
    const result = unwrap(
      await c.deliver({
        kind: 'push',
        repository: REPO,
        ref: `refs/heads/wi/${pbi.id}-login`,
        deleted: false,
        commits: [
          { sha: 'aaa1111', message: `Add form AB#${task.id}`, url: 'u1', author: 'octocat', timestamp: null },
          { sha: 'bbb2222', message: 'No reference', url: 'u2', author: null, timestamp: null },
          { sha: 'ccc3333', message: 'Refs AB#999 (missing)', url: 'u3', author: null, timestamp: null },
        ],
      }),
    );
    assert.deepEqual(result, { result: `Push to wi/${pbi.id}-login: 3 commits`, linked: [pbi.id, task.id] });
    assert.deepEqual(c.unitOfWork.runs.slice(before), [{ meta: { actor: 'GitHub (octocat)', origin: undefined }, committed: true }]);
    assert.deepEqual(c.item(pbi.id).devLinks.map((l) => l.kind), ['branch', 'commit', 'commit', 'commit']);
    assert.deepEqual(c.item(task.id).devLinks.map((l) => l.ref), ['aaa1111']);
    assert.equal(c.item(task.id).history.at(-1)?.note, 'Linked commit aaa1111 in acme/boards');
    assert.ok(c.published.some((e) => e.type === 'DevLinkAdded' && e.workItemId === task.id));
    assert.deepEqual(unwrap(await c.deliver({ kind: 'push', repository: REPO, ref: 'refs/tags/v1', deleted: false, commits: [] })).result, 'Ignored push to a tag');
  });

  it('tracks branches being created and deleted, and ignores tags', async () => {
    const c = await connected();
    const w = await c.create('Task');
    unwrap(await c.deliver({ kind: 'branch', action: 'create', ref: `wi/${w.id}`, repository: REPO }));
    assert.equal(c.item(w.id).devLinks[0]?.state, 'open');
    const deleted = unwrap(await c.deliver({ kind: 'branch', action: 'delete', ref: `wi/${w.id}`, repository: REPO }));
    assert.deepEqual(deleted, { result: `Branch wi/${w.id} deleted`, linked: [w.id] });
    assert.equal(c.item(w.id).devLinks[0]?.state, 'deleted');
    assert.equal(unwrap(await c.deliver({ kind: 'otherRef', action: 'create', refType: 'tag' })).result, 'Ignored create of a tag');
  });

  it('moves linked work along the board as pull requests open and merge', async () => {
    const c = await connected();
    const pbi = await c.create('Product Backlog Item');
    const task = await c.create('Task');
    const feature = await c.create('Feature');
    const body = `AB#${pbi.id} AB#${task.id} AB#${feature.id}`;
    unwrap(await c.deliver({ kind: 'pullRequest', action: 'opened', repository: REPO, pullRequest: pr({ body, draft: true }) }));
    assert.equal(c.item(pbi.id).state, 'New');
    unwrap(await c.deliver({ kind: 'pullRequest', action: 'ready_for_review', repository: REPO, pullRequest: pr({ body }) }));
    assert.equal(c.item(pbi.id).state, 'Committed');
    assert.equal(c.item(task.id).state, 'In Progress');
    assert.equal(c.item(feature.id).state, 'New');
    const started = c.item(task.id).history.at(-1);
    assert.equal(started?.note, 'Pull request #5 opened');
    assert.equal(started?.changedBy, 'GitHub (octocat)');

    const checks = unwrap(await c.deliver({ kind: 'checkSuite', headSha: 'abc123', status: 'completed', conclusion: 'failure' }));
    assert.deepEqual(checks, { result: 'Checks failure for abc123', linked: [pbi.id, task.id, feature.id] });
    assert.equal(c.item(pbi.id).devLinks[0]?.checks, 'failure');

    unwrap(await c.deliver({ kind: 'pullRequest', action: 'closed', repository: REPO, pullRequest: pr({ body, state: 'closed', merged: true }) }));
    assert.equal(c.item(pbi.id).state, 'Done');
    assert.equal(c.item(task.id).state, 'Done');
    assert.ok(c.item(pbi.id).history.some((h) => h.note === 'Pull request #5 merged (acme/boards)'));
    assert.ok(c.item(pbi.id).history.some((h) => h.note === 'Pull request #5 merged' && h.changes.some((ch) => ch.field === 'state')));
  });

  it('follows the settings for moving work, and never moves it backwards', async () => {
    const c = await connected();
    const done = await c.create('Task', { state: 'Done' });
    unwrap(await c.deliver({ kind: 'pullRequest', action: 'opened', repository: REPO, pullRequest: pr({ title: `AB#${done.id}` }) }));
    assert.equal(c.item(done.id).state, 'Done');
    unwrap(await new UpdateGitHubSettings(c.deps).execute({ caller: admin, moveOnPullRequestOpened: false, completeOnMerge: false }));
    const w = await c.create('Task');
    unwrap(await c.deliver({ kind: 'pullRequest', action: 'opened', repository: REPO, pullRequest: pr({ number: 6, title: `AB#${w.id}` }) }));
    unwrap(await c.deliver({ kind: 'pullRequest', action: 'closed', repository: REPO, pullRequest: pr({ number: 6, title: `AB#${w.id}`, state: 'closed', merged: true }) }));
    assert.equal(c.item(w.id).state, 'To Do');
    assert.equal(c.item(w.id).devLinks[0]?.state, 'merged');
  });

  it('only accepts listed repositories once a list is set', async () => {
    const c = await connected();
    const w = await c.create('Task');
    unwrap(await new UpdateGitHubSettings(c.deps).execute({ caller: admin, repositories: ['acme/other'] }));
    const result = unwrap(await c.deliver({ kind: 'branch', action: 'create', ref: `wi/${w.id}`, repository: REPO }));
    assert.equal(result.result, 'Ignored: acme/boards is not in the allowed list');
    assert.deepEqual(c.item(w.id).devLinks, []);
  });

  it('skips duplicates, but tries a delivery that failed again', async () => {
    const c = await connected();
    const w = await c.create('Task');
    const branch: DevelopmentActivity = { kind: 'branch', action: 'create', ref: `wi/${w.id}`, repository: REPO };
    const save = c.items.save.bind(c.items);
    c.items.save = async () => {
      c.items.save = save;
      throw new Error('disk full');
    };
    await assert.rejects(c.deliver(branch, { id: 'retry' }), /disk full/);
    assert.deepEqual(c.item(w.id).devLinks, []);
    assert.equal(unwrap(await c.deliver(branch, { id: 'retry' })).result, `Branch wi/${w.id} created`);
    assert.equal(unwrap(await c.deliver(branch, { id: 'retry' })).result, 'Duplicate delivery ignored');
    assert.equal(c.item(w.id).devLinks.length, 1);
    // Without a delivery id, every delivery is new.
    assert.equal(unwrap(await c.deliver({ kind: 'ping' }, { id: null })).result, 'Ping received — the webhook is connected');

    const view = unwrap(await new GetGitHubAdminView(c.deps).execute({ caller: admin }));
    // Newest first; the duplicate isn't recorded.
    assert.deepEqual(
      view.deliveries.map((d) => [d.ok, d.result]),
      [
        [true, 'Ping received — the webhook is connected'],
        [true, `Branch wi/${w.id} created`],
        [false, 'Failed: disk full'],
      ],
    );
    assert.deepEqual(view.deliveries.slice(1).map((d) => [d.id, d.event, d.repo]), [['retry', 'branch', 'acme/boards'], ['retry', 'branch', 'acme/boards']]);
  });

  it('records ignored events', async () => {
    const c = await connected();
    assert.equal(unwrap(await c.deliver({ kind: 'other', event: 'issues' }, { event: 'issues' })).result, 'Ignored event "issues"');
    const view = unwrap(await new GetGitHubAdminView(c.deps).execute({ caller: admin }));
    assert.deepEqual(view.deliveries.map((d) => d.event), ['issues']);
  });
});

describe('administering the integration', () => {
  it('is for administrators only, never API tokens', async () => {
    const t = setup();
    for (const caller of [bo, tokenCaller]) {
      assert.equal((await new GetGitHubAdminView(t.deps).execute({ caller })).ok, false);
      assert.equal((await new UpdateGitHubSettings(t.deps).execute({ caller, enabled: false })).ok, false);
      assert.equal((await new RotateWebhookSecret(t.deps).execute({ caller })).ok, false);
    }
    assert.deepEqual(t.github.snapshot(), {});
  });

  it('shows the secret once, and only that it exists afterwards', async () => {
    const t = setup();
    const rotated = unwrap(await new RotateWebhookSecret(t.deps).execute({ caller: ann }));
    assert.equal(rotated.secret, 'webhook-1');
    assert.equal(rotated.view.hasSecret, true);
    assert.equal(rotated.view.webhookPath, '/api/integrations/github/webhook');
    assert.ok(!JSON.stringify(rotated.view).includes('webhook-1'));
    assert.equal(t.github.snapshot().secret, 'webhook-1');
    assert.ok(t.published.some((e) => e.type === 'WebhookSecretRotated'));
  });

  it('validates settings before saving them', async () => {
    const t = setup();
    const result = await new UpdateGitHubSettings(t.deps).execute({ caller: admin, repositories: ['nope'] });
    assert.deepEqual(result, { ok: false, error: { code: 'REPOSITORY_INVALID', value: 'nope' } });
    const view = unwrap(await new UpdateGitHubSettings(t.deps).execute({ caller: admin, repositories: ['acme/boards'], enabled: false }));
    assert.deepEqual(view.settings, { enabled: false, moveOnPullRequestOpened: true, completeOnMerge: true, repositories: ['acme/boards'] });
  });
});

describe('removing a development link', () => {
  it('removes it from the item and notes who did', async () => {
    const c = await connected();
    const w = await c.create('Task');
    unwrap(await c.deliver({ kind: 'branch', action: 'create', ref: `wi/${w.id}`, repository: REPO }));
    const remove = new RemoveDevLink(c.deps);
    assert.deepEqual(await remove.execute({ caller: bo, workItemId: w.id, linkId: 'nope' }), { ok: false, error: { code: 'DEV_LINK_NOT_FOUND', id: 'nope' } });
    assert.deepEqual(await remove.execute({ caller: bo, workItemId: 99, linkId: 'x' }), { ok: false, error: { code: 'WORK_ITEM_NOT_FOUND', id: 99 } });
    unwrap(await remove.execute({ caller: bo, workItemId: w.id, linkId: `branch:acme/boards:wi/${w.id}` }));
    assert.deepEqual(c.item(w.id).devLinks, []);
    assert.equal(c.item(w.id).history.at(-1)?.note, `Removed link to branch wi/${w.id}`);
    assert.equal(c.item(w.id).history.at(-1)?.changedBy, 'Bo');
  });
});
