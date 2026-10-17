import { looksLikeApiToken, type ApiTokenInfo } from '#domain/api-tokens/api-token.ts';
import type { Account } from '#domain/sign-in/account.ts';
import { afterFailure, isForgotten, lockoutKey, minutesLocked } from '#domain/sign-in/lockout.ts';
import { isSessionLive, sessionsToEnd } from '#domain/sign-in/session.ts';
import type { SignInSettings } from '#domain/sign-in/settings.ts';
import type { Member } from '#domain/types.ts';
import type { AccountSummary, AuthAdminView, AuthUser } from '../contracts/auth.ts';
import type { SignInDeps } from './deps.ts';

// Steps shared by the sign-in use cases. They orchestrate; the rules are in the domain.

export function userView(member: Member, account: Account, settings: SignInSettings): AuthUser {
  const expires = account.expiresAt(settings.passwordExpiryDays);
  return { memberId: member.id, name: member.name, username: member.username, isAdmin: account.isAdmin, passwordExpiresAt: expires ? expires.toISOString() : null };
}

/** What administrators see about everyone's account. Never includes passwords or their hashes. */
export async function adminView(deps: Pick<SignInDeps, 'team' | 'accounts' | 'failedAttempts' | 'signInSettings' | 'signInForcedOff' | 'clock'>): Promise<AuthAdminView> {
  const now = deps.clock.now();
  const settings = await deps.signInSettings.get();
  const accounts: AccountSummary[] = [];
  for (const member of await deps.team.all()) {
    const account = await deps.accounts.get(member.id);
    const expires = account.expiresAt(settings.passwordExpiryDays);
    const failures = member.username ? await deps.failedAttempts.find(lockoutKey(member.username)) : undefined;
    accounts.push({
      memberId: member.id,
      isAdmin: account.isAdmin,
      hasPassword: account.hasPassword,
      passwordSetAt: account.passwordSetAt,
      passwordExpiresAt: expires ? expires.toISOString() : null,
      expired: account.isExpired(now, settings.passwordExpiryDays),
      mustChange: account.mustChange,
      lockedUntil: failures && minutesLocked(failures, now) > 0 ? new Date(failures.lockedUntil).toISOString() : null,
    });
  }
  return { settings: settings.toSnapshot(), overridden: deps.signInForcedOff, accounts };
}

/** Count a failed attempt against a username, forgetting old records of other usernames. */
export async function recordFailure(deps: Pick<SignInDeps, 'failedAttempts' | 'clock'>, key: string): Promise<void> {
  const now = deps.clock.now();
  await deps.failedAttempts.sweep(now, (record) => isForgotten(record, now));
  await deps.failedAttempts.save(key, afterFailure(await deps.failedAttempts.find(key), now));
}

/** Minutes the username is locked for, or 0. */
export async function lockedMinutes(deps: Pick<SignInDeps, 'failedAttempts' | 'clock'>, username: string): Promise<number> {
  return minutesLocked(await deps.failedAttempts.find(lockoutKey(username)), deps.clock.now());
}

/** Sign someone in on this browser: a new session, ending sessions that timed out and their oldest beyond the limit. */
export async function startSession(deps: Pick<SignInDeps, 'sessions' | 'secrets' | 'signInSettings' | 'clock'>, memberId: string): Promise<string> {
  const now = deps.clock.now();
  const settings = await deps.signInSettings.get();
  for (const s of await deps.sessions.all()) {
    if (!isSessionLive(s, now, settings.sessionTimeoutMinutes)) await deps.sessions.delete(s.token);
  }
  for (const s of sessionsToEnd(await deps.sessions.forMember(memberId))) await deps.sessions.delete(s.token);
  const token = deps.secrets.newSessionToken();
  await deps.sessions.save({ token, memberId, createdAt: now.getTime(), lastSeen: now.getTime() });
  return token;
}

/** Sign someone out everywhere. */
export async function endSessions(deps: Pick<SignInDeps, 'sessions'>, memberId: string): Promise<void> {
  for (const s of await deps.sessions.forMember(memberId)) await deps.sessions.delete(s.token);
}

/** Revoke every API token that acts as the member, in one write that no damaged token can stop. */
export async function revokeTokens(deps: Pick<SignInDeps, 'apiTokens' | 'clock' | 'events'>, memberId: string): Promise<void> {
  const ids = await deps.apiTokens.deleteForMember(memberId);
  const occurredAt = deps.clock.now();
  if (ids.length) await deps.events.publish(ids.map((tokenId) => ({ type: 'ApiTokenRevoked', tokenId, memberId, occurredAt })));
}

/**
 * The member a session belongs to, or null if it timed out or can no longer be used (member
 * gone or inactive, password cleared, temporary or expired). Dead sessions are ended.
 */
export async function memberForSession(
  deps: Pick<SignInDeps, 'sessions' | 'team' | 'accounts' | 'signInSettings' | 'clock'>,
  token: string,
  touch: boolean,
): Promise<Member | null> {
  const session = await deps.sessions.find(token);
  if (!session) return null;
  const now = deps.clock.now();
  const settings = await deps.signInSettings.get();
  const member = await deps.team.findById(session.memberId);
  const account = await deps.accounts.get(session.memberId);
  const usable =
    isSessionLive(session, now, settings.sessionTimeoutMinutes) &&
    !!member?.active &&
    !!member.username &&
    account.canHoldSession(now, settings.passwordExpiryDays);
  if (!usable || !member) {
    await deps.sessions.delete(token);
    return null;
  }
  if (touch) await deps.sessions.touch(token, now.getTime());
  return member;
}

/** The member and token for a presented API token secret, or null if unknown, expired or its member is gone. */
export async function memberForApiToken(
  deps: Pick<SignInDeps, 'apiTokens' | 'secrets' | 'team' | 'clock'>,
  secret: string,
): Promise<{ member: Member; token: ApiTokenInfo } | null> {
  if (!looksLikeApiToken(secret)) return null;
  const token = await deps.apiTokens.findByDigest(deps.secrets.digest(secret));
  const now = deps.clock.now();
  if (!token || token.isExpired(now)) return null;
  const member = await deps.team.findById(token.memberId);
  if (!member?.active) return null;
  token.recordUse(now);
  await deps.apiTokens.saveUse(token);
  return { member, token: token.toInfo(now) };
}
