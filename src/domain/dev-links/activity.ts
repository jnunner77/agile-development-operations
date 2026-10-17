import type { CheckResult, DevLinkDraft, DevLinkState } from './dev-link.ts';
import { branchIds, mentionedIds } from './references.ts';

// Source control activity as the domain sees it. Infrastructure translates GitHub's webhook
// payloads into these shapes; the rules below decide what each one links to.

/** Commits linked from one push, at most. */
export const MAX_COMMITS_PER_PUSH = 50;

export interface SourceRepository {
  /** owner/name */
  readonly fullName: string;
  readonly htmlUrl: string;
  /** Unknown for some events; then any base branch counts as the default. */
  readonly defaultBranch: string | null;
}

export interface PushedCommit {
  readonly sha: string;
  readonly message: string;
  readonly url: string;
  readonly author: string | null;
  readonly timestamp: string | null;
}

export interface PullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly url: string;
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  readonly draft: boolean;
  readonly author: string | null;
  readonly headRef: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly createdAt: string | null;
}

export type DevelopmentActivity =
  | { readonly kind: 'ping' }
  | { readonly kind: 'push'; readonly repository: SourceRepository; readonly ref: string; readonly deleted: boolean; readonly commits: readonly PushedCommit[] }
  | { readonly kind: 'branch'; readonly action: 'create' | 'delete'; readonly ref: string; readonly repository: SourceRepository }
  /** A tag (or anything else that isn't a branch) was created or deleted. */
  | { readonly kind: 'otherRef'; readonly action: 'create' | 'delete'; readonly refType: string }
  | { readonly kind: 'pullRequest'; readonly action: string; readonly repository: SourceRepository; readonly pullRequest: PullRequest }
  | { readonly kind: 'checkSuite'; readonly headSha: string | null; readonly status: string; readonly conclusion: string | null }
  | { readonly kind: 'other'; readonly event: string };

/** One webhook delivery: where it came from, who caused it, and what happened. */
export interface DevelopmentEvent {
  /** owner/name, or '' when the delivery names no repository. */
  readonly repository: string;
  /** The account that caused the event, if known. */
  readonly sender: string | null;
  readonly activity: DevelopmentActivity;
}

/** The branch a push went to, or null for a push to a tag. */
export function pushedBranch(ref: string): string | null {
  const prefix = 'refs/heads/';
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
}

export function branchLink(repository: SourceRepository, branch: string, state: 'open' | 'deleted', author: string, now: string): DevLinkDraft {
  return {
    kind: 'branch',
    repo: repository.fullName,
    ref: branch,
    title: branch,
    url: `${repository.htmlUrl}/tree/${encodeURIComponent(branch).replace(/%2F/g, '/')}`,
    state,
    author,
    createdAt: now,
  };
}

/** Items a pushed commit belongs to: those it mentions, and the item its branch is named after. */
export function commitItemIds(branch: string, commit: PushedCommit): number[] {
  return [...new Set([...branchIds(branch), ...mentionedIds(commit.message)])];
}

export function commitLink(repository: SourceRepository, commit: PushedCommit, now: string): DevLinkDraft {
  return {
    kind: 'commit',
    repo: repository.fullName,
    ref: commit.sha,
    title: (commit.message.split('\n')[0] ?? '').slice(0, 200),
    url: commit.url,
    state: null,
    author: commit.author ?? 'unknown',
    createdAt: commit.timestamp ?? now,
  };
}

export function pullRequestState(pr: PullRequest): DevLinkState {
  if (pr.merged) return 'merged';
  return pr.state === 'closed' ? 'closed' : 'open';
}

/** Items a pull request belongs to: those its title or description mention, and its branch's item. */
export function pullRequestItemIds(pr: PullRequest): number[] {
  return [...new Set([...mentionedIds(pr.title), ...mentionedIds(pr.body), ...branchIds(pr.headRef)])];
}

export function pullRequestLink(repository: SourceRepository, pr: PullRequest, now: string): DevLinkDraft {
  return {
    kind: 'pullRequest',
    repo: repository.fullName,
    ref: String(pr.number),
    title: pr.title.slice(0, 300),
    url: pr.url,
    state: pullRequestState(pr),
    draft: pr.draft,
    headSha: pr.headSha,
    baseRef: pr.baseRef,
    author: pr.author ?? 'unknown',
    createdAt: pr.createdAt ?? now,
  };
}

/** A pull request that is open for review (not a draft) starts the work it is linked to. */
export function startsWork(action: string, pr: PullRequest): boolean {
  return ['opened', 'reopened', 'ready_for_review'].includes(action) && pullRequestState(pr) === 'open' && !pr.draft;
}

/** Merging into the default branch finishes the work. */
export function finishesWork(action: string, repository: SourceRepository, pr: PullRequest): boolean {
  return action === 'closed' && pullRequestState(pr) === 'merged' && (!repository.defaultBranch || pr.baseRef === repository.defaultBranch);
}

/** A check suite's outcome: neutral and skipped runs count as passing. */
export function checkResult(status: string, conclusion: string | null): CheckResult {
  if (status !== 'completed') return 'pending';
  return conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped' ? 'success' : 'failure';
}

/** Name recorded in work item history for changes made by source control events. */
export function activityActor(sender: string | null): string {
  return sender ? `GitHub (${sender})` : 'GitHub';
}
