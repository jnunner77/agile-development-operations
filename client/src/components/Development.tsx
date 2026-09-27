import { useState } from 'react';
import { branchNameFor, mentionFor } from '../../../shared/devlinks';
import type { DevLink, WorkItem } from '../../../shared/types';
import { api } from '../api';
import { timeAgo } from '../lib/format';
import { toast } from '../store';
import { confirmDialog } from './common';
import { Icon } from './Icon';

const COMMITS_SHOWN = 5;

function copy(text: string, what: string) {
  void navigator.clipboard?.writeText(text).then(
    () => toast(`${what} copied`),
    () => toast(`Couldn't copy. ${what}: ${text}`, 'error'),
  );
}

export function PrStateBadge({ link }: { link: DevLink }) {
  const state = link.state === 'open' && link.draft ? 'draft' : (link.state ?? 'open');
  return <span className={`pr-state pr-${state}`}>{state === 'open' ? 'Open' : state[0].toUpperCase() + state.slice(1)}</span>;
}

export function ChecksIcon({ checks }: { checks: DevLink['checks'] }) {
  if (!checks) return null;
  const label = checks === 'success' ? 'Checks passed' : checks === 'failure' ? 'Checks failed' : 'Checks running';
  return (
    <span className={`checks checks-${checks}`} title={label} aria-label={label}>
      <Icon name={checks === 'success' ? 'check' : checks === 'failure' ? 'close' : 'history'} size={12} />
    </span>
  );
}

/** Linked branches, commits and pull requests for a work item, like Azure DevOps' Development section. */
export function DevelopmentSection({ item }: { item: WorkItem }) {
  const [allCommits, setAllCommits] = useState(false);
  const links = item.devLinks ?? [];
  const byNewest = (a: DevLink, b: DevLink) => b.updatedAt.localeCompare(a.updatedAt);
  const prs = links.filter((l) => l.kind === 'pullRequest').sort(byNewest);
  const branches = links.filter((l) => l.kind === 'branch').sort(byNewest);
  const commits = links.filter((l) => l.kind === 'commit').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const branch = branchNameFor(item.id, item.title);

  const remove = async (link: DevLink) => {
    const ok = await confirmDialog({
      title: 'Remove this link?',
      message: 'It will come back if GitHub sends another event that mentions this work item.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (ok) await api.removeDevLink(item.id, link.id);
  };

  const row = (link: DevLink, icon: string, label: string) => (
    <div key={link.id} className={`dev-link ${link.state === 'deleted' ? 'muted' : ''}`}>
      <Icon name={icon} size={14} />
      <div className="dev-link-main">
        <a href={link.url} target="_blank" rel="noopener noreferrer" title={link.title}>
          {label}
        </a>
        <div className="muted small">
          {link.repo} · {link.author} · {timeAgo(link.updatedAt)}
        </div>
      </div>
      {link.kind === 'pullRequest' && <ChecksIcon checks={link.checks} />}
      {link.kind === 'pullRequest' && <PrStateBadge link={link} />}
      {link.kind === 'branch' && link.state === 'deleted' && <span className="badge">Deleted</span>}
      <button className="icon-btn" aria-label="Remove link" onClick={() => remove(link)}>
        <Icon name="close" size={12} />
      </button>
    </div>
  );

  return (
    <section className="wi-section">
      <div className="wi-section-header">
        <h3>Development</h3>
      </div>
      <div className="dev-actions">
        <button className="btn btn-small" onClick={() => copy(branch, 'Branch name')} title={branch}>
          <Icon name="branch" size={12} /> Copy branch name
        </button>
        <button className="btn btn-small" onClick={() => copy(mentionFor(item.id), 'Mention')}>
          <Icon name="link" size={12} /> Copy {mentionFor(item.id)}
        </button>
      </div>
      {links.length === 0 && (
        <p className="muted small">
          Name a branch <code>{branch}</code>, or mention <code>{mentionFor(item.id)}</code> in a commit message or pull request, and it will appear
          here.
        </p>
      )}
      {prs.length > 0 && <div className="related-label">Pull requests</div>}
      {prs.map((l) => row(l, 'pullRequest', `#${l.ref} ${l.title}`))}
      {branches.length > 0 && <div className="related-label">Branches</div>}
      {branches.map((l) => row(l, 'branch', l.ref))}
      {commits.length > 0 && <div className="related-label">Commits</div>}
      {(allCommits ? commits : commits.slice(0, COMMITS_SHOWN)).map((l) => row(l, 'commit', `${l.ref.slice(0, 7)} ${l.title}`))}
      {commits.length > COMMITS_SHOWN && (
        <button className="link-btn small" onClick={() => setAllCommits(!allCommits)}>
          {allCommits ? 'Show fewer' : `Show all ${commits.length} commits`}
        </button>
      )}
    </section>
  );
}
