import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  activityActor,
  branchLink,
  checkResult,
  commitItemIds,
  commitLink,
  finishesWork,
  pullRequestItemIds,
  pullRequestLink,
  pullRequestState,
  pushedBranch,
  startsWork,
  type PullRequest,
  type PushedCommit,
  type SourceRepository,
} from '#domain/dev-links/activity.ts';
import { advancedState } from '#domain/dev-links/automation.ts';
import { MAX_DEV_LINKS_PER_ITEM, describeDevLink, devLinkId, type DevLinkDraft } from '#domain/dev-links/dev-link.ts';
import { branchIds, branchNameFor, mentionedIds } from '#domain/dev-links/references.ts';
import { DEFAULT_GITHUB_SETTINGS, GitHubIntegration, GitHubSettingsChanges } from '#domain/integrations/github.ts';
import { LATER, NOW, ctx, newItem } from './fixtures.ts';

const REPO: SourceRepository = { fullName: 'acme/boards', htmlUrl: 'https://github.com/acme/boards', defaultBranch: 'main' };
const at = NOW.toISOString();

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

const commit = (fields: Partial<PushedCommit> = {}): PushedCommit => ({
  sha: 'aaa1111bbb',
  message: 'Add form AB#2\n\nDetails',
  url: 'https://github.com/acme/boards/commit/aaa1111',
  author: 'octocat',
  timestamp: null,
  ...fields,
});

describe('references', () => {
  it('finds AB# mentions and work item branch names', () => {
    assert.deepEqual(mentionedIds('Fix AB#12, ab#7 and AB#12; not AB#x or XAB#9'), [12, 7]);
    assert.deepEqual(branchIds('feature/wi-7_fix'), [7]);
    assert.deepEqual(branchIds('swift/12-thing'), []);
    assert.equal(branchNameFor(42, 'Add login: SSO & MFA!'), 'wi/42-add-login-sso-mfa');
  });
});

describe('development activity', () => {
  it('names links by kind, repository and ref, whatever the repository case', () => {
    assert.equal(devLinkId({ kind: 'branch', repo: 'Acme/Boards', ref: 'wi/1' }), 'branch:acme/boards:wi/1');
    assert.equal(describeDevLink({ kind: 'commit', ref: 'aaa1111bbb' }), 'commit aaa1111');
    assert.equal(describeDevLink({ kind: 'pullRequest', ref: '5' }), 'pull request #5');
    assert.equal(describeDevLink({ kind: 'branch', ref: 'wi/1' }), 'branch wi/1');
  });

  it('reads pushes to branches, not tags', () => {
    assert.equal(pushedBranch('refs/heads/wi/1-x'), 'wi/1-x');
    assert.equal(pushedBranch('refs/tags/v1'), null);
  });

  it('links branches with a GitHub tree URL', () => {
    assert.deepEqual(branchLink(REPO, 'wi/1 x', 'open', 'octocat', at), {
      kind: 'branch',
      repo: 'acme/boards',
      ref: 'wi/1 x',
      title: 'wi/1 x',
      url: 'https://github.com/acme/boards/tree/wi/1%20x',
      state: 'open',
      author: 'octocat',
      createdAt: at,
    });
  });

  it('links commits to the items they mention and their branch item', () => {
    assert.deepEqual(commitItemIds('wi/9-x', commit()).sort(), [2, 9]);
    const link = commitLink(REPO, commit({ author: null, message: 'x'.repeat(300) }), at);
    assert.equal(link.title.length, 200);
    assert.equal(link.author, 'unknown');
    assert.equal(link.createdAt, at);
    assert.equal(commitLink(REPO, commit({ timestamp: '2026-01-01T00:00:00Z' }), at).createdAt, '2026-01-01T00:00:00Z');
  });

  it('tells a pull request apart as open, closed or merged', () => {
    assert.equal(pullRequestState(pr()), 'open');
    assert.equal(pullRequestState(pr({ state: 'closed' })), 'closed');
    assert.equal(pullRequestState(pr({ state: 'closed', merged: true })), 'merged');
    assert.deepEqual(pullRequestItemIds(pr({ title: 'AB#1', body: 'AB#2 and AB#1', headRef: 'wi/3-x' })), [1, 2, 3]);
    const link = pullRequestLink(REPO, pr({ draft: true }), at);
    assert.equal(link.ref, '5');
    assert.equal(link.draft, true);
    assert.equal(link.headSha, 'abc123');
    assert.equal(link.baseRef, 'main');
  });

  it('starts work when a pull request is ready for review, finishes it when merged into the default branch', () => {
    assert.equal(startsWork('opened', pr()), true);
    assert.equal(startsWork('ready_for_review', pr()), true);
    assert.equal(startsWork('opened', pr({ draft: true })), false);
    assert.equal(startsWork('edited', pr()), false);
    const merged = pr({ state: 'closed', merged: true });
    assert.equal(finishesWork('closed', REPO, merged), true);
    assert.equal(finishesWork('closed', REPO, pr({ state: 'closed' })), false);
    assert.equal(finishesWork('closed', REPO, { ...merged, baseRef: 'release/1' }), false);
    assert.equal(finishesWork('closed', { ...REPO, defaultBranch: null }, { ...merged, baseRef: 'release/1' }), true);
  });

  it('reads check suite results', () => {
    assert.equal(checkResult('in_progress', null), 'pending');
    assert.equal(checkResult('completed', 'success'), 'success');
    assert.equal(checkResult('completed', 'skipped'), 'success');
    assert.equal(checkResult('completed', 'timed_out'), 'failure');
    assert.equal(activityActor('octocat'), 'GitHub (octocat)');
    assert.equal(activityActor(null), 'GitHub');
  });

  it('moves PBIs, bugs and tasks forwards only', () => {
    assert.equal(advancedState('Product Backlog Item', 'Approved', 'InProgress'), 'Committed');
    assert.equal(advancedState('Task', 'To Do', 'InProgress'), 'In Progress');
    assert.equal(advancedState('Bug', 'New', 'Completed'), 'Done');
    assert.equal(advancedState('Product Backlog Item', 'Done', 'InProgress'), null);
    assert.equal(advancedState('Task', 'In Progress', 'InProgress'), null);
    assert.equal(advancedState('Task', 'Removed', 'Completed'), null);
    assert.equal(advancedState('Feature', 'New', 'InProgress'), null);
  });
});

describe('development links on a work item', () => {
  const draft = (fields: Partial<DevLinkDraft> = {}): DevLinkDraft => ({ ...branchLink(REPO, 'wi/1', 'open', 'octocat', at), ...fields });

  it('adds a link once and notes it in the history', () => {
    const item = newItem('Task');
    item.linkDevelopment(draft(), ctx('h2', NOW, 'GitHub (octocat)'));
    const snap = item.toSnapshot();
    assert.deepEqual(snap.devLinks, [{ ...draft(), id: 'branch:acme/boards:wi/1', checks: null, updatedAt: at }]);
    assert.deepEqual(snap.history.at(-1), { id: 'h2', changedBy: 'GitHub (octocat)', changedAt: at, changes: [], note: 'Linked branch wi/1 in acme/boards' });
    assert.equal(snap.changedBy, 'GitHub (octocat)');
    assert.deepEqual(item.pullEvents().map((e) => e.type), ['DevLinkAdded']);
  });

  it('updates the same link later, keeping when it was created and its checks', () => {
    const item = newItem('Task');
    const open = pullRequestLink(REPO, pr(), at);
    item.linkDevelopment(open, ctx('h2'));
    assert.equal(item.recordChecks('abc123', 'success', NOW), true);
    assert.equal(item.recordChecks('abc123', 'success', NOW), false);
    assert.equal(item.recordChecks('other', 'failure', NOW), false);
    item.linkDevelopment({ ...open, title: 'Renamed', createdAt: LATER.toISOString() }, ctx('h3', LATER));
    let [link] = item.toSnapshot().devLinks;
    assert.equal(link?.title, 'Renamed');
    assert.equal(link?.createdAt, at);
    assert.equal(link?.checks, 'success');
    assert.equal(link?.updatedAt, LATER.toISOString());
    // Only a change of state is noted.
    assert.equal(item.toSnapshot().history.length, 2);
    item.linkDevelopment({ ...open, state: 'merged' }, ctx('h4', LATER));
    item.linkDevelopment({ ...open, state: 'open' }, ctx('h5', LATER));
    assert.deepEqual(item.toSnapshot().history.slice(-2).map((h) => h.note), ['Pull request #5 merged (acme/boards)', 'Pull request #5 reopened (acme/boards)']);
    [link] = item.toSnapshot().devLinks;
    assert.equal(link?.state, 'open');
    assert.deepEqual(item.pullEvents().map((e) => e.type), ['DevLinkAdded', 'DevLinkUpdated', 'DevLinkUpdated', 'DevLinkUpdated', 'DevLinkUpdated']);
  });

  it('makes room for new links by dropping the oldest commit first', () => {
    const item = newItem('Task');
    item.linkDevelopment(draft(), ctx());
    for (let i = 0; i < MAX_DEV_LINKS_PER_ITEM - 1; i++) item.linkDevelopment(commitLink(REPO, commit({ sha: `c${i}` }), at), ctx());
    item.linkDevelopment(draft({ ref: 'wi/1-new' }), ctx());
    const refs = item.toSnapshot().devLinks.map((l) => l.ref);
    assert.equal(refs.length, MAX_DEV_LINKS_PER_ITEM);
    assert.equal(refs[0], 'wi/1');
    assert.ok(!refs.includes('c0'));
    assert.equal(refs.at(-1), 'wi/1-new');
  });

  it('removes a link, or says it is not there', () => {
    const item = newItem('Task');
    item.linkDevelopment(draft(), ctx());
    assert.deepEqual(item.removeDevLink('nope', ctx()), { ok: false, error: { code: 'DEV_LINK_NOT_FOUND', id: 'nope' } });
    assert.equal(item.removeDevLink('branch:acme/boards:wi/1', ctx('h9', LATER, 'Bo')).ok, true);
    const snap = item.toSnapshot();
    assert.deepEqual(snap.devLinks, []);
    assert.equal(snap.history.at(-1)?.note, 'Removed link to branch wi/1');
    assert.equal(snap.changedBy, 'Bo');
  });
});

describe('GitHub integration', () => {
  it('starts with defaults and no secret, so the webhook is closed', () => {
    const integration = GitHubIntegration.reconstitute(undefined);
    assert.deepEqual(integration.settings, DEFAULT_GITHUB_SETTINGS);
    assert.equal(integration.hasSecret, false);
    assert.equal(integration.webhookSecret, null);
    integration.rotateSecret('s3cret', NOW);
    assert.equal(integration.webhookSecret, 's3cret');
    assert.deepEqual(integration.pullEvents(), [{ type: 'WebhookSecretRotated', occurredAt: NOW }]);
  });

  it('closes the webhook while it is turned off, keeping the secret', () => {
    const integration = GitHubIntegration.reconstitute({ secret: 's3cret', enabled: false });
    assert.equal(integration.hasSecret, true);
    assert.equal(integration.webhookSecret, null);
  });

  it('validates repository names and applies changes', () => {
    assert.deepEqual(GitHubSettingsChanges.validate({ repositories: ['not a repo'] }), { ok: false, error: { code: 'REPOSITORY_INVALID', value: 'not a repo' } });
    assert.equal(GitHubSettingsChanges.validate({ repositories: [`a/${'b'.repeat(200)}`] }).ok, false);
    assert.equal(GitHubSettingsChanges.validate({ repositories: Array.from({ length: 51 }, (_, i) => `a/r${i}`) }).ok, false);
    const changes = GitHubSettingsChanges.validate({ repositories: [' Acme/Boards '], completeOnMerge: false });
    assert.ok(changes.ok);
    const integration = GitHubIntegration.reconstitute({});
    integration.update(changes.value, NOW);
    assert.deepEqual(integration.settings.repositories, ['Acme/Boards']);
    assert.equal(integration.completeOnMerge, false);
    assert.equal(integration.moveOnPullRequestOpened, true);
    assert.equal(integration.acceptsRepository('acme/boards'), true);
    assert.equal(integration.acceptsRepository('acme/other'), false);
    assert.equal(GitHubIntegration.reconstitute({}).acceptsRepository(''), true);
  });

  it('never hands out its stored arrays', () => {
    const integration = GitHubIntegration.reconstitute({ repositories: ['a/b'] });
    integration.settings.repositories.push('c/d');
    integration.toSnapshot().repositories.push('e/f');
    assert.deepEqual(integration.settings.repositories, ['a/b']);
  });
});
