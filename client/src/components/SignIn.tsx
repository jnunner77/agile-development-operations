import { useState } from 'react';
import type { LoginResult } from '../../../shared/auth';
import { authApi, connectEvents, loadAll } from '../api';
import { toast, useStore } from '../store';
import { Modal } from './common';
import { Icon } from './Icon';

type Step = { kind: 'login' } | { kind: 'setup' } | { kind: 'change'; reason: 'expired' | 'temporary' };

const message = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong');

/** Check a new password on the client so people get feedback before submitting. */
function passwordProblem(pw: string, confirm: string, username: string, min: number) {
  if (pw.length < min) return `Use at least ${min} characters.`;
  if (pw.toLowerCase() === username.trim().toLowerCase()) return "A password can't be the same as the username.";
  if (pw !== confirm) return "The passwords don't match.";
  return null;
}

async function finishSignIn() {
  // Refresh status (it carries the signed-in user), then load data.
  const status = await authApi.status();
  useStore.setState({ auth: status, signInRequired: false });
  await loadAll();
  connectEvents();
}

export function SignInScreen() {
  const project = useStore((s) => s.settings.projectName);
  const min = useStore((s) => s.auth?.passwordMinLength ?? 8);
  const expiryDays = useStore((s) => s.auth?.settings.passwordExpiryDays ?? 0);
  const [step, setStep] = useState<Step>({ kind: 'login' });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const handle = async (result: LoginResult) => {
    if (result.status === 'ok') return finishSignIn();
    setNewPassword('');
    setConfirm('');
    setStep(result.status === 'setup' ? { kind: 'setup' } : { kind: 'change', reason: result.reason });
  };

  const submitLogin = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => handle(await authApi.login(username, password)));
  };

  const submitNew = (e: React.FormEvent) => {
    e.preventDefault();
    const problem = passwordProblem(newPassword, confirm, username, min);
    if (problem) return setError(problem);
    void run(async () => {
      await authApi.setPassword({ username, currentPassword: step.kind === 'change' ? password : undefined, newPassword });
      await finishSignIn();
    });
  };

  const back = () => {
    setStep({ kind: 'login' });
    setPassword('');
    setError(null);
  };

  return (
    <div className="signin">
      <div className="signin-card">
        <div className="signin-brand">
          <span className="project-badge">{(project || 'B').slice(0, 1).toUpperCase()}</span>
          <span>{project || 'Boards'}</span>
        </div>
        {step.kind === 'login' ? (
          <form className="form" onSubmit={submitLogin}>
            <h1>Sign in</h1>
            <label>
              Username
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus required />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </label>
            <p className="muted small">First time signing in? Enter your username and leave the password blank to create one.</p>
            {error && <div className="form-error" role="alert">{error}</div>}
            <button className="btn btn-primary" type="submit" disabled={busy || !username.trim()}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        ) : (
          <form className="form" onSubmit={submitNew}>
            <h1>{step.kind === 'setup' ? 'Create your password' : 'Choose a new password'}</h1>
            <p className="muted">
              {step.kind === 'setup' && (
                <>
                  Welcome, <strong>{username.trim()}</strong>. Choose the password you'll use to sign in from now on.
                </>
              )}
              {step.kind === 'change' && step.reason === 'expired' && 'Your password has expired. Choose a new one to continue.'}
              {step.kind === 'change' && step.reason === 'temporary' && 'An administrator set a temporary password for you. Choose your own to continue.'}
              {expiryDays > 0 && ` Passwords expire after ${expiryDays} days.`}
            </p>
            <label>
              New password
              <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" autoFocus required minLength={min} />
            </label>
            <label>
              Confirm new password
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
            </label>
            <div className="muted small">At least {min} characters, and not the same as your username.</div>
            {error && <div className="form-error" role="alert">{error}</div>}
            <div className="row gap">
              <button className="btn btn-primary" type="submit" disabled={busy || !newPassword || !confirm}>
                {busy ? 'Saving…' : 'Save and sign in'}
              </button>
              <button className="btn" type="button" onClick={back} disabled={busy}>
                Back
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/** Lets a signed-in user change their own password. */
export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const user = useStore((s) => s.auth?.user);
  const min = useStore((s) => s.auth?.passwordMinLength ?? 8);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!user) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = passwordProblem(next, confirm, user.username, min);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await authApi.setPassword({ username: user.username, currentPassword: current, newPassword: next });
      useStore.setState({ auth: await authApi.status() });
      toast('Password changed', 'success');
      onClose();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Change password" onClose={onClose} width={400}>
      <form className="form" onSubmit={submit}>
        <label>
          Current password
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" autoFocus required />
        </label>
        <label>
          New password
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required minLength={min} />
        </label>
        <label>
          Confirm new password
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </label>
        {error && (
          <div className="form-error" role="alert">
            <Icon name="warning" size={14} /> {error}
          </div>
        )}
        <div className="modal-footer inline">
          <button className="btn btn-primary" type="submit" disabled={busy || !current || !next || !confirm}>
            Change password
          </button>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

