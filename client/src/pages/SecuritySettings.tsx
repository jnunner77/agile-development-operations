import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { EXPIRY_DAYS_MAX, SESSION_TIMEOUT_MAX, SESSION_TIMEOUT_MIN, type AccountSummary, type ApiTokenInfo, type AuthAdminView } from '#application/contracts/auth.ts';
import type { Member } from '#domain/types.ts';
import { authApi, requireSignIn, tokensApi } from '../api';
import { Avatar, Modal, confirmDialog } from '../components/common';
import { Icon } from '../components/Icon';
import { formatDateTime } from '../lib/format';
import { toast, useStore } from '../store';

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong');

/** Project settings > Authentication: turn sign-in on, set expiry and timeout, manage each person's account. */
export function SecuritySettings() {
  const [view, setView] = useState<AuthAdminView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(() => {
    authApi
      .admin()
      .then((v) => {
        setView(v);
        setLoadError(null);
      })
      .catch((err) => setLoadError(errorText(err)));
  }, []);
  useEffect(reload, [reload]);

  if (loadError) return <div className="settings-card form-error">{loadError}</div>;
  if (!view) return <div className="settings-card muted">Loading…</div>;
  return (
    <div className="settings-stack">
      <PolicyCard view={view} onChange={setView} />
      <AccountsCard view={view} onChange={setView} />
    </div>
  );
}

/** After a change, pick up the new sign-in status (e.g. we may now need to sign in). */
async function refreshStatus() {
  const status = await authApi.status();
  useStore.setState({ auth: status });
  if (status.enabled && !status.user) requireSignIn();
}

function PolicyCard({ view, onChange }: { view: AuthAdminView; onChange: (v: AuthAdminView) => void }) {
  const members = useStore((s) => s.members);
  const [enabled, setEnabled] = useState(view.settings.enabled);
  const [expires, setExpires] = useState(view.settings.passwordExpiryDays > 0);
  const [expiryDays, setExpiryDays] = useState(String(view.settings.passwordExpiryDays || 60));
  const [timeout, setTimeoutMinutes] = useState(String(view.settings.sessionTimeoutMinutes));
  const [busy, setBusy] = useState(false);

  const days = expires ? Number(expiryDays) : 0;
  const minutes = Number(timeout);
  const daysValid = !expires || (Number.isInteger(days) && days >= 1 && days <= EXPIRY_DAYS_MAX);
  const minutesValid = Number.isInteger(minutes) && minutes >= SESSION_TIMEOUT_MIN && minutes <= SESSION_TIMEOUT_MAX;
  const dirty = enabled !== view.settings.enabled || days !== view.settings.passwordExpiryDays || minutes !== view.settings.sessionTimeoutMinutes;
  const readyAdmins = members.filter((m) => {
    const a = view.accounts.find((x) => x.memberId === m.id);
    return m.active && m.username && a?.isAdmin && a.hasPassword;
  });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    // API tokens made while sign-in was off could have been made by anyone: list all tokens and
    // offer to revoke them (ticked by default) before turning sign-in on.
    let revoke: ApiTokenInfo[] = [];
    if (enabled && !view.settings.enabled) {
      // The server refuses this too; checking first means no token is revoked for a turn-on that fails.
      if (!readyAdmins.length) {
        return toast('Before turning on sign-in, make at least one active team member with a username an administrator and give them a password (Set password…).', 'error');
      }
      let tokens: ApiTokenInfo[] = [];
      try {
        tokens = (await tokensApi.list()).filter((t) => !t.expired);
      } catch (err) {
        return toast(errorText(err), 'error');
      }
      let revokeTokens = true;
      const name = (id: string) => members.find((m) => m.id === id)?.name ?? 'Former team member';
      const ok = await confirmDialog({
        title: 'Turn on sign-in?',
        message: (
          <>
            <p>
              Everyone will need to sign in with the username from Team members. People without a password can’t sign in until you set a temporary password for them (Set password… below).
              Team members without a username won’t be able to sign in.
            </p>
            {tokens.length > 0 && (
              <div className="callout callout-warn callout-stack">
                <p>
                  <Icon name="warning" size={14} /> {tokens.length === 1 ? 'This API token keeps' : `These ${tokens.length} API tokens keep`} working after sign-in is on. Any made while sign-in was off could have been made by anyone:
                </p>
                <ul>
                  {tokens.map((t) => (
                    <li key={t.id}>
                      <strong>{t.name}</strong> ({t.scope === 'write' ? 'read & write' : 'read-only'}) acts as {name(t.memberId)}, created by {t.createdBy} {formatDateTime(t.createdAt)}
                    </li>
                  ))}
                </ul>
                <label className="check-row">
                  <input type="checkbox" defaultChecked onChange={(e) => (revokeTokens = e.target.checked)} /> Revoke {tokens.length === 1 ? 'it' : 'them'} (untick only if you know who made {tokens.length === 1 ? 'it' : 'them'})
                </label>
              </div>
            )}
          </>
        ),
        confirmLabel: 'Turn on sign-in',
      });
      if (!ok) return;
      if (revokeTokens) revoke = tokens;
    }
    setBusy(true);
    try {
      // Revoke first: once sign-in is on, this page needs a session to do it.
      for (const t of revoke) await tokensApi.revoke(t.id);
      if (revoke.length) toast(`Revoked ${revoke.length} API token${revoke.length === 1 ? '' : 's'}`, 'success');
      onChange(await authApi.updateSettings({ enabled, passwordExpiryDays: days, sessionTimeoutMinutes: minutes }));
      toast('Authentication settings saved', 'success');
      await refreshStatus();
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form settings-card" onSubmit={save}>
      <h2>Authentication</h2>
      {view.overridden && (
        <div className="callout callout-warn">
          <Icon name="warning" size={14} /> Sign-in is forced off on the server by the <code>AUTH_DISABLED</code> setting, so anyone can use the app. Remove it and restart the server to turn sign-in back on.
        </div>
      )}
      <label className="check-row">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Require people to sign in
      </label>
      <div className="muted small">
        People sign in with the username set in <Link to="/settings/team">Team members</Link>. With sign-in off, anyone can pick who they're acting as.
        {enabled && !readyAdmins.length && ' Before turning it on, make at least one active team member with a username an administrator below and give them a password (Set password…).'}
      </div>
      <fieldset>
        <legend>Password expiry</legend>
        <label className="check-row">
          <input type="checkbox" checked={expires} onChange={(e) => setExpires(e.target.checked)} /> Passwords expire
        </label>
        {expires && (
          <div className="row gap inline-field">
            <span>After</span>
            <input type="number" min={1} max={EXPIRY_DAYS_MAX} value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)} aria-label="Days until a password expires" className="num-input" />
            <span>days, people must choose a new password when they next sign in.</span>
          </div>
        )}
      </fieldset>
      <fieldset>
        <legend>Session timeout</legend>
        <div className="row gap inline-field">
          <span>Sign people out after</span>
          <input
            type="number"
            min={SESSION_TIMEOUT_MIN}
            max={SESSION_TIMEOUT_MAX}
            value={timeout}
            onChange={(e) => setTimeoutMinutes(e.target.value)}
            aria-label="Minutes of inactivity before signing out"
            className="num-input"
          />
          <span>minutes of inactivity.</span>
        </div>
        <div className="muted small">
          Between {SESSION_TIMEOUT_MIN} minutes and 7 days ({SESSION_TIMEOUT_MAX} minutes). Restarting the server also signs everyone out.
        </div>
      </fieldset>
      <div className="row gap">
        <button className="btn btn-primary" type="submit" disabled={busy || !dirty || !daysValid || !minutesValid}>
          Save
        </button>
        {(!daysValid || !minutesValid) && <span className="form-error">{!daysValid ? `Expiry must be 1–${EXPIRY_DAYS_MAX} days.` : `Timeout must be ${SESSION_TIMEOUT_MIN}–${SESSION_TIMEOUT_MAX} minutes.`}</span>}
      </div>
    </form>
  );
}

function passwordStatus(a: AccountSummary | undefined, m: Member) {
  if (!m.username) return <span className="muted">No username — can't sign in</span>;
  if (!a?.hasPassword) return <span className="muted">Not set — can't sign in yet</span>;
  if (a.lockedUntil) return <span className="text-danger">Locked until {formatDateTime(a.lockedUntil)}</span>;
  if (a.mustChange) return <span className="text-warn">Temporary — must change at sign-in</span>;
  if (a.expired) return <span className="text-danger">Expired</span>;
  if (a.passwordExpiresAt) return <span title={a.passwordSetAt ? `Set ${formatDateTime(a.passwordSetAt)}` : undefined}>Expires {formatDateTime(a.passwordExpiresAt)}</span>;
  return <span>Set</span>;
}

function AccountsCard({ view, onChange }: { view: AuthAdminView; onChange: (v: AuthAdminView) => void }) {
  const members = useStore((s) => s.members);
  const myId = useStore((s) => s.auth?.user?.memberId);
  const [settingFor, setSettingFor] = useState<Member | null>(null);

  const act = async (fn: () => Promise<AuthAdminView>, success: string) => {
    try {
      onChange(await fn());
      toast(success, 'success');
      await refreshStatus();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };

  const reset = async (m: Member) => {
    const ok = await confirmDialog({
      title: `Reset ${m.name}'s password?`,
      message: `Their current password stops working, they're signed out everywhere and their API tokens are revoked. They can't sign in again until you set a new (temporary) password for them with Set password….`,
      confirmLabel: 'Reset password',
      danger: true,
    });
    if (ok) await act(() => authApi.resetPassword(m.id), `${m.name}'s password was reset`);
  };

  return (
    <div className="settings-card">
      <h2>People</h2>
      <p className="muted small">Administrators can change these settings, manage team members and project settings, and set or reset anyone's password. Passwords are stored as salted one-way hashes, so nobody (administrators included) can see them.</p>
      <table className="grid">
        <thead>
          <tr>
            <th>Name</th>
            <th>Username</th>
            <th>Administrator</th>
            <th>Password</th>
            <th className="col-actions" />
          </tr>
        </thead>
        <tbody>
          {members.map((m) => {
            const a = view.accounts.find((x) => x.memberId === m.id);
            return (
              <tr key={m.id} className="grid-row">
                <td>
                  <span className="person">
                    <Avatar member={m} size={26} /> {m.name}
                    {!m.active && <span className="badge">Inactive</span>}
                  </span>
                </td>
                <td className="muted">{m.username}</td>
                <td>
                  <input
                    type="checkbox"
                    checked={!!a?.isAdmin}
                    aria-label={`${m.name} is an administrator`}
                    onChange={(e) => {
                      const on = e.target.checked;
                      void act(() => authApi.setAdmin(m.id, on), on ? `${m.name} is now an administrator` : `${m.name} is no longer an administrator`);
                    }}
                  />
                  {m.id === myId && <span className="muted small"> (you)</span>}
                </td>
                <td>{passwordStatus(a, m)}</td>
                <td className="col-actions nowrap">
                  <button className="btn btn-ghost btn-small" disabled={!m.username} onClick={() => setSettingFor(m)} title={m.username ? undefined : 'Add a username in Team members first'}>
                    Set password…
                  </button>
                  <button className="btn btn-ghost btn-small" disabled={!a?.hasPassword} onClick={() => void reset(m)}>
                    Reset
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {settingFor && (
        <SetPasswordDialog
          member={settingFor}
          onClose={() => setSettingFor(null)}
          onSave={async (pw, mustChange) => {
            onChange(await authApi.setPasswordFor(settingFor.id, pw, mustChange));
            toast(mustChange ? `Temporary password set for ${settingFor.name}` : `Password set for ${settingFor.name}`, 'success');
            await refreshStatus();
          }}
        />
      )}
    </div>
  );
}

function SetPasswordDialog({ member, onClose, onSave }: { member: Member; onClose: () => void; onSave: (pw: string, mustChange: boolean) => Promise<void> }) {
  const min = useStore((s) => s.auth?.passwordMinLength ?? 8);
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mustChange, setMustChange] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw.length < min) return setError(`Use at least ${min} characters.`);
    if (pw !== confirm) return setError("The passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      await onSave(pw, mustChange);
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Set password for ${member.name}`} onClose={onClose} width={420}>
      <form className="form" onSubmit={submit}>
        <p className="muted small">
          Username: <strong>{member.username}</strong>. They'll be signed out everywhere and their API tokens revoked.
        </p>
        <label>
          New password
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" autoFocus required minLength={min} />
        </label>
        <label>
          Confirm password
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </label>
        <label className="check-row">
          <input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} /> Make them choose a new password at next sign-in
        </label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="modal-footer inline">
          <button className="btn btn-primary" type="submit" disabled={busy || !pw || !confirm}>
            Set password
          </button>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
