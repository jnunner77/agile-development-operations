/** Types shared by the server's sign-in system and the client screens that use it. */

import type { SignInSettingsData } from '#domain/sign-in/settings.ts';

export { DEFAULT_SIGN_IN_SETTINGS as DEFAULT_AUTH_SETTINGS, EXPIRY_DAYS_MAX, SESSION_TIMEOUT_MAX, SESSION_TIMEOUT_MIN } from '#domain/sign-in/settings.ts';
export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '#domain/sign-in/password.ts';
export type { ApiTokenInfo, ApiTokenScope } from '#domain/api-tokens/api-token.ts';

export type AuthSettings = SignInSettingsData;

/** The signed-in user as the client sees them. */
export interface AuthUser {
  memberId: string;
  name: string;
  username: string;
  isAdmin: boolean;
  /** ISO timestamp, or null when passwords don't expire. */
  passwordExpiresAt: string | null;
}

export interface AuthStatus {
  enabled: boolean;
  /** True when sign-in is forced off with the AUTH_DISABLED environment variable. */
  overridden: boolean;
  user: AuthUser | null;
  settings: AuthSettings;
  passwordMinLength: number;
}

/**
 * Result of a sign-in attempt.
 * - ok: signed in.
 * - change: the password is expired or temporary and must be replaced.
 */
export type LoginResult =
  | { status: 'ok'; user: AuthUser }
  | { status: 'change'; reason: 'expired' | 'temporary' };

/** What administrators see about each team member's sign-in account. Never includes the password. */
export interface AccountSummary {
  memberId: string;
  isAdmin: boolean;
  hasPassword: boolean;
  passwordSetAt: string | null;
  passwordExpiresAt: string | null;
  expired: boolean;
  /** Set by an administrator; the user must choose a new password at next sign-in. */
  mustChange: boolean;
  /** Set after too many failed sign-in attempts. */
  lockedUntil: string | null;
}

export interface AuthAdminView {
  settings: AuthSettings;
  overridden: boolean;
  accounts: AccountSummary[];
}
