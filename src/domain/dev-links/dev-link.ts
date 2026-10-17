import type { DevLink, DevLinkKind } from '../types.ts';

/** Most development links one work item keeps. Old commits make way for new links first. */
export const MAX_DEV_LINKS_PER_ITEM = 200;

export type DevLinkState = DevLink['state'];
export type CheckResult = NonNullable<DevLink['checks']>;

/** A branch, commit or pull request to link to a work item, before it has an id. */
export interface DevLinkDraft {
  readonly kind: DevLinkKind;
  /** owner/name */
  readonly repo: string;
  /** Branch name, commit SHA, or pull request number. */
  readonly ref: string;
  readonly title: string;
  readonly url: string;
  readonly state: DevLinkState;
  readonly author: string;
  readonly createdAt: string;
  /** Pull requests only. */
  readonly draft?: boolean;
  readonly headSha?: string | null;
  readonly baseRef?: string | null;
}

/** The same branch, commit or pull request always gets the same id, so later events update its link. */
export function devLinkId(link: Pick<DevLinkDraft, 'kind' | 'repo' | 'ref'>): string {
  return `${link.kind}:${link.repo.toLowerCase()}:${link.ref}`;
}

/** "pull request #5", "commit abc1234", "branch wi/12-login": how history notes name a link. */
export function describeDevLink(link: Pick<DevLink, 'kind' | 'ref'>): string {
  switch (link.kind) {
    case 'pullRequest':
      return `pull request #${link.ref}`;
    case 'commit':
      return `commit ${link.ref.slice(0, 7)}`;
    case 'branch':
      return `branch ${link.ref}`;
  }
}

/** Which link to drop to make room for a new one: the oldest commit, else the oldest link. */
export function linkToEvict(links: readonly Pick<DevLink, 'kind'>[]): number {
  const oldestCommit = links.findIndex((l) => l.kind === 'commit');
  return oldestCommit >= 0 ? oldestCommit : 0;
}
