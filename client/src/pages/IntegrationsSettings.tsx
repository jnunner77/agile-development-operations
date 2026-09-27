import { useCallback, useEffect, useState } from 'react';
import type { GitHubAdminView } from '../../../shared/integrations';
import { githubApi } from '../api';
import { confirmDialog } from '../components/common';
import { Icon } from '../components/Icon';
import { timeAgo } from '../lib/format';
import { toast } from '../store';

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong');

/** Project settings > Integrations: connect a GitHub repository with a webhook. */
export function IntegrationsSettings() {
  const [view, setView] = useState<GitHubAdminView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  const reload = useCallback(() => {
    githubApi
      .get()
      .then((v) => {
        setView(v);
        setLoadError(null);
      })
      .catch((err) => setLoadError(errorText(err)));
  }, []);
  useEffect(reload, [reload]);

  if (loadError) return <div className="settings-card form-error">{loadError}</div>;
  if (!view) return <div className="settings-card muted">Loading…</div>;

  const url = `${window.location.origin}${view.webhookPath}`;
  const copy = (text: string, what: string) => void navigator.clipboard?.writeText(text).then(() => toast(`${what} copied`));

  const rotate = async () => {
    if (view.hasSecret) {
      const ok = await confirmDialog({
        title: 'Create a new secret?',
        message: 'The current secret stops working immediately. Paste the new one into the GitHub webhook settings, or deliveries will be rejected.',
        confirmLabel: 'Create new secret',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      const r = await githubApi.rotateSecret();
      setSecret(r.secret);
      setView(r.view);
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };

  return (
    <div className="settings-stack">
      <div className="settings-card">
        <h2>
          <Icon name="github" size={18} /> GitHub
        </h2>
        <p className="muted small">
          Link branches, commits and pull requests to work items. GitHub notifies this app through a webhook; anything that mentions <code>AB#123</code>, or a
          branch named like <code>wi/123-short-title</code>, is linked to work item 123 and shows up in its <em>Development</em> section.
        </p>

        <ol className="setup-steps">
          <li>
            <strong>Create a secret.</strong> GitHub signs every delivery with it, and this app rejects anything unsigned.
            <div className="row gap pad-t">
              <button className="btn btn-primary" onClick={rotate}>
                <Icon name="lock" size={14} /> {view.hasSecret ? 'Create a new secret' : 'Create secret'}
              </button>
              {view.hasSecret && !secret && <span className="muted small">A secret is set. It can't be shown again; create a new one if you need it.</span>}
            </div>
            {secret && (
              <div className="secret-box">
                <code>{secret}</code>
                <button className="btn btn-small" onClick={() => copy(secret, 'Secret')}>
                  <Icon name="copy" size={12} /> Copy
                </button>
                <div className="warn small">Copy it now: it won't be shown again.</div>
              </div>
            )}
          </li>
          <li>
            <strong>Add the webhook in GitHub:</strong> in your repository, open <em>Settings → Webhooks → Add webhook</em> and enter:
            <table className="kv">
              <tbody>
                <tr>
                  <th>Payload URL</th>
                  <td>
                    <code>{url}</code>{' '}
                    <button className="icon-btn" aria-label="Copy webhook URL" onClick={() => copy(url, 'Webhook URL')}>
                      <Icon name="copy" size={12} />
                    </button>
                  </td>
                </tr>
                <tr>
                  <th>Content type</th>
                  <td>
                    <code>application/json</code>
                  </td>
                </tr>
                <tr>
                  <th>Secret</th>
                  <td>the secret from step 1</td>
                </tr>
                <tr>
                  <th>Events</th>
                  <td>
                    <em>Let me select individual events</em>: Branch or tag creation, Branch or tag deletion, Check suites, Pull requests, Pushes
                  </td>
                </tr>
              </tbody>
            </table>
            {window.location.protocol !== 'https:' && <div className="warn small">This page isn't on HTTPS; GitHub needs a public HTTPS address to deliver to.</div>}
          </li>
          <li>
            <strong>Check it worked:</strong> GitHub sends a <em>ping</em> straight away. It appears under <em>Recent deliveries</em> below.
          </li>
        </ol>
      </div>

      <OptionsCard view={view} onChange={setView} />

      <div className="settings-card">
        <div className="row between">
          <h2>Recent deliveries</h2>
          <button className="icon-btn" title="Refresh" aria-label="Refresh deliveries" onClick={reload}>
            <Icon name="restore" size={14} />
          </button>
        </div>
        {view.deliveries.length === 0 ? (
          <p className="muted small">Nothing received since the server last started.</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Received</th>
                <th>Event</th>
                <th>Repository</th>
                <th>Result</th>
                <th>Linked items</th>
              </tr>
            </thead>
            <tbody>
              {view.deliveries.map((d) => (
                <tr key={d.id} className="grid-row">
                  <td className="small" title={d.receivedAt}>
                    {timeAgo(d.receivedAt)}
                  </td>
                  <td>
                    <code>{d.event}</code>
                  </td>
                  <td className="small">{d.repo}</td>
                  <td className={`small ${d.ok ? '' : 'warn'}`}>{d.result}</td>
                  <td className="small">{d.linked.length ? d.linked.map((id) => `#${id}`).join(', ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function OptionsCard({ view, onChange }: { view: GitHubAdminView; onChange: (v: GitHubAdminView) => void }) {
  const [s, setS] = useState(view.settings);
  const [repos, setRepos] = useState(view.settings.repositories.join('\n'));
  const repoList = repos
    .split(/[\s,]+/)
    .map((r) => r.trim())
    .filter(Boolean);
  const dirty = JSON.stringify({ ...s, repositories: repoList }) !== JSON.stringify(view.settings);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      onChange(await githubApi.update({ ...s, repositories: repoList }));
      toast('GitHub settings saved', 'success');
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };

  return (
    <form className="settings-card form" onSubmit={save}>
      <h2>Options</h2>
      <label className="check-row">
        <input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> Accept webhook deliveries
      </label>
      <label className="check-row">
        <input type="checkbox" checked={s.moveOnPullRequestOpened} onChange={(e) => setS({ ...s, moveOnPullRequestOpened: e.target.checked })} /> When a pull request
        opens, move linked backlog items to <em>Committed</em> and tasks to <em>In Progress</em>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={s.completeOnMerge} onChange={(e) => setS({ ...s, completeOnMerge: e.target.checked })} /> When a pull request merges into
        the default branch, move linked backlog items and tasks to <em>Done</em>
      </label>
      <div className="muted small">Work never moves backwards, draft pull requests don't move anything, and epics and features are never moved.</div>
      <label>
        Only accept these repositories <span className="muted small">(owner/name, one per line; leave empty to accept any)</span>
        <textarea rows={3} value={repos} onChange={(e) => setRepos(e.target.value)} placeholder="jnunner77/agile-development-operations" />
      </label>
      <div>
        <button className="btn btn-primary" type="submit" disabled={!dirty}>
          Save
        </button>
      </div>
    </form>
  );
}
