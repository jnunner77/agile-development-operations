import { useCallback, useEffect, useState } from 'react';
import type { ApiTokenInfo, ApiTokenScope } from '../../../shared/auth';
import { tokensApi } from '../api';
import { Avatar, EmptyState, confirmDialog } from '../components/common';
import { Icon } from '../components/Icon';
import { formatDateTime, timeAgo } from '../lib/format';
import { toast, useStore } from '../store';
import { useCanAdminister } from './SettingsPage';

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong');
const EXPIRY_CHOICES = [7, 30, 90, 180, 365];

/** Project settings > API tokens: tokens let scripts and assistants use the API as a team member. */
export function ApiTokensSettings() {
  const [tokens, setTokens] = useState<ApiTokenInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ token: string; info: ApiTokenInfo } | null>(null);
  const members = useStore((s) => s.members);
  const canAdminister = useCanAdminister();

  const reload = useCallback(() => {
    tokensApi
      .list()
      .then((t) => {
        setTokens(t);
        setLoadError(null);
      })
      .catch((err) => setLoadError(errorText(err)));
  }, []);
  useEffect(reload, [reload]);

  const revoke = async (t: ApiTokenInfo) => {
    const ok = await confirmDialog({
      title: `Revoke "${t.name}"?`,
      message: 'Anything using this token stops working immediately.',
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!ok) return;
    try {
      await tokensApi.revoke(t.id);
      if (created?.info.id === t.id) setCreated(null);
      reload();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };

  const origin = window.location.origin;
  const copy = (text: string, what: string) => void navigator.clipboard?.writeText(text).then(() => toast(`${what} copied`));

  return (
    <div className="settings-stack">
      <div className="settings-card">
        <h2>API tokens</h2>
        <p className="muted small">
          A token lets a script or an assistant such as Claude use this app's API without a password. It acts as one team member, is either read-only or read
          &amp; write, and expires. Tokens can't manage sign-in, settings, team members, backups or other tokens. Treat a token like a password: store it
          in a secret store, never in code or chat.
        </p>
        <CreateToken
          members={members.filter((m) => m.active)}
          canChooseMember={canAdminister}
          onCreated={(c) => {
            setCreated(c);
            reload();
          }}
        />
        {created && (
          <div className="secret-box token-created">
            <div className="row gap wrap">
              <strong>Your new token "{created.info.name}"</strong>
              <span className="warn small">Copy it now: it won't be shown again.</span>
            </div>
            <code>{created.token}</code>
            <div className="row gap wrap">
              <button className="btn btn-small btn-primary" onClick={() => copy(created.token, 'Token')}>
                <Icon name="copy" size={12} /> Copy token
              </button>
              <button className="btn btn-small" onClick={() => setCreated(null)}>
                Done
              </button>
            </div>
            <div className="muted small">
              Test it: <code>{`curl -H "Authorization: Bearer <token>" ${origin}/api/auth/status`}</code>
            </div>
          </div>
        )}
      </div>

      <div className="settings-card">
        <div className="row between">
          <h2>{canAdminister ? 'All tokens' : 'Your tokens'}</h2>
          <button className="icon-btn" title="Refresh" aria-label="Refresh tokens" onClick={reload}>
            <Icon name="restore" size={14} />
          </button>
        </div>
        {loadError ? (
          <div className="form-error">{loadError}</div>
        ) : !tokens ? (
          <div className="muted">Loading…</div>
        ) : tokens.length === 0 ? (
          <EmptyState icon="lock" title="No API tokens yet" />
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Name</th>
                <th>Acts as</th>
                <th>Access</th>
                <th className="hide-sm">Created</th>
                <th>Expires</th>
                <th className="hide-sm">Last used</th>
                <th className="col-actions" />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => {
                const m = members.find((x) => x.id === t.memberId);
                return (
                  <tr key={t.id} className="grid-row">
                    <td>
                      <strong>{t.name}</strong>
                      <div className="muted small">
                        <code>{t.prefix}…</code>
                      </div>
                    </td>
                    <td>
                      <span className="person">
                        <Avatar member={m} size={22} /> <span className="hide-sm">{m?.name ?? 'Former member'}</span>
                      </span>
                    </td>
                    <td>{t.scope === 'write' ? 'Read & write' : 'Read-only'}</td>
                    <td className="small hide-sm" title={formatDateTime(t.createdAt)}>
                      {timeAgo(t.createdAt)} <span className="muted">by {t.createdBy}</span>
                    </td>
                    <td className={`small ${t.expired ? 'warn' : ''}`} title={formatDateTime(t.expiresAt)}>
                      {t.expired ? 'Expired' : new Date(t.expiresAt).toLocaleDateString()}
                    </td>
                    <td className="small muted hide-sm">{t.lastUsedAt ? timeAgo(t.lastUsedAt) : 'Never'}</td>
                    <td className="col-actions">
                      <button className="btn btn-small" onClick={() => revoke(t)}>
                        Revoke
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function CreateToken({
  members,
  canChooseMember,
  onCreated,
}: {
  members: { id: string; name: string }[];
  canChooseMember: boolean;
  onCreated: (c: { token: string; info: ApiTokenInfo }) => void;
}) {
  const me = useStore((s) => s.auth?.user?.memberId ?? s.currentUserId);
  const [name, setName] = useState('');
  const [memberId, setMemberId] = useState(me ?? '');
  const [scope, setScope] = useState<ApiTokenScope>('read');
  const [days, setDays] = useState(90);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      onCreated(await tokensApi.create({ name: name.trim(), memberId: canChooseMember ? memberId : undefined, scope, expiresInDays: days }));
      setName('');
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form token-form" onSubmit={submit}>
      <div className="form-row">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Claude" maxLength={100} required />
        </label>
        {canChooseMember && (
          <label>
            Acts as
            <select value={memberId} onChange={(e) => setMemberId(e.target.value)} required>
              <option value="" disabled>
                Choose a team member
              </option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="form-row">
        <label>
          Access
          <select value={scope} onChange={(e) => setScope(e.target.value as ApiTokenScope)}>
            <option value="read">Read-only</option>
            <option value="write">Read &amp; write (create and change work items)</option>
          </select>
        </label>
        <label>
          Expires after
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {EXPIRY_CHOICES.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>
      </div>
      <div>
        <button className="btn btn-primary" type="submit" disabled={busy || !name.trim() || (canChooseMember && !memberId)}>
          <Icon name="lock" size={14} /> Create token
        </button>
      </div>
    </form>
  );
}
