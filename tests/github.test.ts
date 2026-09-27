import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { AuthManager } from '../server/auth';
import { GitHubIntegration } from '../server/github';
import { emptyDatabase } from '../server/schema';
import { SnapshotManager } from '../server/snapshots';
import { Store } from '../server/store';
import { branchIds, branchNameFor, mentionedIds } from '../shared/devlinks';
import type { WorkItem } from '../shared/types';

let dir: string;
let store: Store;
let app: ReturnType<typeof createApp>;
let secret: string;

const REPO = { full_name: 'acme/boards', html_url: 'https://github.com/acme/boards', default_branch: 'main' };
const SENDER = { login: 'octocat' };

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boards-github-'));
  store = new Store(dir, () => emptyDatabase());
  app = createApp({ store, snapshots: new SnapshotManager(store), security: false });
  secret = (await request(app).post('/api/integrations/github/secret')).body.secret;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

let delivery = 0;
function deliver(event: string, payload: unknown, opts: { secret?: string; id?: string; target?: typeof app } = {}) {
  const body = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', opts.secret ?? secret).update(body).digest('hex');
  return request(opts.target ?? app)
    .post('/api/integrations/github/webhook')
    .set('Content-Type', 'application/json')
    .set('X-GitHub-Event', event)
    .set('X-GitHub-Delivery', opts.id ?? `d-${++delivery}`)
    .set('X-Hub-Signature-256', sig)
    .send(body);
}

async function create(type: string, title = `${type} item`) {
  const res = await request(app).post('/api/workitems').send({ type, title });
  return res.body.result as WorkItem;
}

const item = (id: number) => store.db.workItems.find((w) => w.id === id)!;

function pr(number: number, fields: Record<string, unknown> = {}) {
  return {
    number,
    title: 'Add login',
    body: null,
    html_url: `https://github.com/acme/boards/pull/${number}`,
    state: 'open',
    merged: false,
    draft: false,
    user: SENDER,
    head: { ref: 'feature/x', sha: 'abc123' },
    base: { ref: 'main' },
    ...fields,
  };
}

describe('reference parsing', () => {
  it('finds AB# mentions and work item branch names', () => {
    expect(mentionedIds('Fix login (AB#12, ab#7) and AB#12 again; not AB#x or XAB#9')).toEqual([12, 7]);
    expect(branchIds('wi/42-add-login')).toEqual([42]);
    expect(branchIds('feature/wi-7_fix')).toEqual([7]);
    expect(branchIds('AB123-thing')).toEqual([123]);
    expect(branchIds('fix/AB#5')).toEqual([5]);
    expect(branchIds('swift/12-thing')).toEqual([]);
    expect(branchIds('main')).toEqual([]);
    expect(branchNameFor(42, 'Add login: SSO & MFA!')).toBe('wi/42-add-login-sso-mfa');
    expect(branchNameFor(3, '!!!')).toBe('wi/3');
  });
});

describe('webhook security', () => {
  it('rejects bad or missing signatures and unknown secrets', async () => {
    await create('Task');
    const payload = { zen: 'hi', repository: REPO };
    expect((await deliver('ping', payload, { secret: 'wrong' })).status).toBe(401);
    const unsigned = await request(app).post('/api/integrations/github/webhook').set('X-GitHub-Event', 'ping').send(payload);
    expect(unsigned.status).toBe(401);
    expect((await deliver('ping', payload)).status).toBe(200);
  });

  it('is disabled until a secret is created', async () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'boards-github-'));
    const s2 = new Store(fresh, () => emptyDatabase());
    const app2 = createApp({ store: s2, snapshots: new SnapshotManager(s2), security: false });
    expect((await deliver('ping', { repository: REPO }, { target: app2 })).status).toBe(404);
    fs.rmSync(fresh, { recursive: true, force: true });
  });

  it('ignores duplicate deliveries', async () => {
    const task = await create('Task');
    const payload = { ref: 'wi/1', ref_type: 'branch', repository: REPO, sender: SENDER };
    expect(task.id).toBe(1);
    await deliver('create', payload, { id: 'same' });
    const dup = await deliver('create', payload, { id: 'same' });
    expect(dup.body.result).toMatch(/Duplicate/);
    expect(item(1).devLinks).toHaveLength(1);
  });

  it('works while sign-in is on, without a session', async () => {
    const auth = new AuthManager(store);
    const signedIn = createApp({ store, snapshots: new SnapshotManager(store), auth, security: false, github: new GitHubIntegration(store) });
    const member = (await request(signedIn).post('/api/members').send({ name: 'Ada', username: 'ada' })).body.result;
    await request(signedIn).patch(`/api/auth/accounts/${member.id}`).send({ isAdmin: true });
    await request(signedIn).put('/api/auth/settings').send({ enabled: true });
    await create('Task');
    expect((await request(signedIn).get('/api/integrations/github')).status).toBe(401);
    const res = await deliver('create', { ref: 'wi/1-x', ref_type: 'branch', repository: REPO, sender: SENDER }, { target: signedIn });
    expect(res.status).toBe(200);
    expect(item(1).devLinks).toHaveLength(1);
  });

  it('never exposes the secret to browsers, snapshots or exports', async () => {
    expect(JSON.stringify((await request(app).get('/api/bootstrap')).body)).not.toContain(secret);
    expect(JSON.stringify((await request(app).get('/api/backup/export')).body)).not.toContain(secret);
    const view = (await request(app).get('/api/integrations/github')).body;
    expect(view.hasSecret).toBe(true);
    expect(JSON.stringify(view)).not.toContain(secret);
    expect(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).not.toContain(secret);
  });

  it('only accepts listed repositories when a list is set', async () => {
    await create('Task');
    await request(app).put('/api/integrations/github').send({ repositories: ['acme/other'] });
    const res = await deliver('create', { ref: 'wi/1', ref_type: 'branch', repository: REPO, sender: SENDER });
    expect(res.body.result).toMatch(/not in the allowed list/);
    expect(item(1).devLinks).toHaveLength(0);
  });
});

describe('linking', () => {
  it('links branches and commits from pushes', async () => {
    const pbi = await create('Product Backlog Item');
    const task = await create('Task');
    const res = await deliver('push', {
      ref: `refs/heads/wi/${pbi.id}-login`,
      repository: REPO,
      sender: SENDER,
      commits: [
        { id: 'aaa1111', message: `Add form AB#${task.id}\n\nDetails`, url: 'https://github.com/acme/boards/commit/aaa1111', author: { username: 'octocat' } },
        { id: 'bbb2222', message: 'No reference', url: 'u' },
        { id: 'ccc3333', message: `Refs AB#999 (missing) and AB#${pbi.id}`, url: 'https://github.com/acme/boards/commit/ccc3333' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.linked.sort()).toEqual([pbi.id, task.id].sort());
    // The branch is wi/<pbi>, so all three commits pushed to it are linked to the PBI.
    expect(item(pbi.id).devLinks.map((l) => l.kind).sort()).toEqual(['branch', 'commit', 'commit', 'commit']);
    expect(item(pbi.id).devLinks.find((l) => l.kind === 'branch')!.author).toBe('octocat');
    const commit = item(task.id).devLinks[0];
    expect(commit).toMatchObject({ kind: 'commit', ref: 'aaa1111', title: `Add form AB#${task.id}`, author: 'octocat', repo: 'acme/boards' });
    expect(item(task.id).history.at(-1)!.note).toBe('Linked commit aaa1111 in acme/boards');
    expect(item(task.id).history.at(-1)!.changedBy).toBe('GitHub (octocat)');
    // Pushing the same commit again doesn't duplicate it.
    await deliver('push', { ref: 'refs/heads/other', repository: REPO, sender: SENDER, commits: [{ id: 'aaa1111', message: `Add form AB#${task.id}`, url: 'x' }] });
    expect(item(task.id).devLinks).toHaveLength(1);
  });

  it('tracks branch creation and deletion', async () => {
    const w = await create('Product Backlog Item');
    await deliver('create', { ref: `wi/${w.id}-thing`, ref_type: 'branch', repository: REPO, sender: SENDER });
    expect(item(w.id).devLinks[0]).toMatchObject({ kind: 'branch', state: 'open', url: `https://github.com/acme/boards/tree/wi/${w.id}-thing` });
    await deliver('delete', { ref: `wi/${w.id}-thing`, ref_type: 'branch', repository: REPO, sender: SENDER });
    expect(item(w.id).devLinks[0].state).toBe('deleted');
    await deliver('create', { ref: 'v1.0', ref_type: 'tag', repository: REPO, sender: SENDER });
    expect(item(w.id).devLinks).toHaveLength(1);
  });

  it('links pull requests and moves work along the board', async () => {
    const pbi = await create('Product Backlog Item');
    const task = await create('Task');
    const feature = await create('Feature');
    await request(app).patch(`/api/workitems/${pbi.id}`).send({ state: 'Approved' });
    const body = `Implements AB#${pbi.id} and AB#${task.id}. Part of AB#${feature.id}.`;

    await deliver('pull_request', { action: 'opened', pull_request: pr(5, { body, draft: true }), repository: REPO, sender: SENDER });
    expect(item(pbi.id).devLinks[0]).toMatchObject({ kind: 'pullRequest', ref: '5', state: 'open', draft: true, headSha: 'abc123' });
    expect(item(pbi.id).state).toBe('Approved'); // drafts don't move work

    await deliver('pull_request', { action: 'ready_for_review', pull_request: pr(5, { body }), repository: REPO, sender: SENDER });
    expect(item(pbi.id).state).toBe('Committed');
    expect(item(task.id).state).toBe('In Progress');
    expect(item(feature.id).state).toBe('New'); // features and epics are never moved automatically

    await deliver('check_suite', { action: 'completed', check_suite: { head_sha: 'abc123', status: 'completed', conclusion: 'failure' }, repository: REPO, sender: SENDER });
    expect(item(pbi.id).devLinks[0].checks).toBe('failure');

    await deliver('pull_request', { action: 'closed', pull_request: pr(5, { body, state: 'closed', merged: true, merged_at: '2026-01-01T00:00:00Z' }), repository: REPO, sender: SENDER });
    expect(item(pbi.id).devLinks[0].state).toBe('merged');
    expect(item(pbi.id).state).toBe('Done');
    expect(item(task.id).state).toBe('Done');
    expect(item(pbi.id).history.some((h) => h.note === 'Pull request #5 merged' && h.changes.some((c) => c.field === 'state'))).toBe(true);
    expect(item(pbi.id).history.some((h) => h.note === 'Pull request #5 merged (acme/boards)')).toBe(true);
  });

  it('never moves work backwards and respects the settings', async () => {
    const done = await create('Product Backlog Item');
    await request(app).patch(`/api/workitems/${done.id}`).send({ state: 'Done' });
    await deliver('pull_request', { action: 'opened', pull_request: pr(6, { title: `AB#${done.id}` }), repository: REPO, sender: SENDER });
    expect(item(done.id).state).toBe('Done');

    await request(app).put('/api/integrations/github').send({ moveOnPullRequestOpened: false, completeOnMerge: false });
    const w = await create('Product Backlog Item');
    await deliver('pull_request', { action: 'opened', pull_request: pr(7, { title: `AB#${w.id}` }), repository: REPO, sender: SENDER });
    expect(item(w.id).state).toBe('New');
    await deliver('pull_request', { action: 'closed', pull_request: pr(7, { title: `AB#${w.id}`, state: 'closed', merged: true }), repository: REPO, sender: SENDER });
    expect(item(w.id).state).toBe('New');
    expect(item(w.id).devLinks[0].state).toBe('merged');
  });

  it('only completes work when merging into the default branch', async () => {
    const w = await create('Task');
    await deliver('pull_request', { action: 'closed', pull_request: pr(8, { title: `AB#${w.id}`, state: 'closed', merged: true, base: { ref: 'release/1' } }), repository: REPO, sender: SENDER });
    expect(item(w.id).state).toBe('To Do');
  });

  it('links a pull request through its branch name', async () => {
    const w = await create('Bug');
    await deliver('pull_request', { action: 'opened', pull_request: pr(9, { head: { ref: `wi/${w.id}-crash`, sha: 'def' } }), repository: REPO, sender: SENDER });
    expect(item(w.id).devLinks.map((l) => l.kind)).toEqual(['pullRequest']);
  });

  it('lets people remove a link, and pushes changes to browsers', async () => {
    const w = await create('Task');
    await deliver('create', { ref: `wi/${w.id}`, ref_type: 'branch', repository: REPO, sender: SENDER });
    const seen: number[] = [];
    store.subscribe((d) => d.workItems?.forEach((x) => seen.push(x.id)));
    const linkId = item(w.id).devLinks[0].id;
    const res = await request(app).delete(`/api/workitems/${w.id}/devlinks/${encodeURIComponent(linkId)}`);
    expect(res.status).toBe(200);
    expect(item(w.id).devLinks).toHaveLength(0);
    expect(seen).toContain(w.id);
  });

  it('records recent deliveries for the settings page', async () => {
    await deliver('ping', { zen: 'hi', repository: REPO, sender: SENDER });
    await deliver('issues', { repository: REPO, sender: SENDER });
    const view = (await request(app).get('/api/integrations/github')).body;
    expect(view.deliveries.map((d: { event: string }) => d.event)).toEqual(['issues', 'ping']);
    expect(view.deliveries[1].result).toMatch(/connected/);
  });
});
