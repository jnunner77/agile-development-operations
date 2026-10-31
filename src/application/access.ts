import { err, ok, type Result } from '#shared/result.ts';
import type { AdminAccess, Caller } from './caller.ts';
import type { Identity } from './sign-in/identity.ts';

export type AccessError = { readonly code: 'ADMIN_ONLY'; readonly reason: 'token' | 'not-admin' };

export function requireAdmin(caller: Caller): Result<void, AccessError> {
  return caller.admin === 'granted' ? ok(undefined) : err({ code: 'ADMIN_ONLY', reason: caller.admin });
}

/**
 * Who may administer the project: never an API token; with sign-in on only administrators; with
 * sign-in off anyone.
 */
export function adminAccessOf(identity: Identity): AdminAccess {
  if (identity.via === 'token') return 'token';
  if (identity.signInEnabled && !identity.isAdmin) return 'not-admin';
  return 'granted';
}

/**
 * Who may change anyone's comments: with sign-in off anyone; otherwise administrators, and never
 * an API token. Everyone may change their own.
 */
export function mayModerateCommentsOf(identity: Identity): boolean {
  if (identity.via === 'token') return false;
  return !identity.signInEnabled || identity.isAdmin;
}

/**
 * Who is never held to the operation rate limits: only an administrator signed in with a session
 * while sign-in is on. Never an API token, and nobody while sign-in is off. Sign-in attempts and
 * lockouts apply to everyone.
 */
export function exemptFromRateLimits(identity: Identity): boolean {
  return identity.via === 'session' && identity.signInEnabled && identity.isAdmin && identity.member !== null;
}
