/** Types shared by the server's sign-in system and the client screens that use it. */

export interface AuthSettings {
  /** When false the app works as before: anyone can pick who they are acting as. */
  enabled: boolean;
  /** Days before a password must be changed. 0 means passwords never expire. */
  passwordExpiryDays: number;
  /** Minutes of inactivity before a signed-in user is signed out. */
  sessionTimeoutMinutes: number;
}

export const DEFAULT_AUTH_SETTINGS: AuthSettings = {
  enabled: false,
  passwordExpiryDays: 60,
  sessionTimeoutMinutes: 60,
};

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;
export const EXPIRY_DAYS_MAX = 3650;
export const SESSION_TIMEOUT_MIN = 5;
export const SESSION_TIMEOUT_MAX = 7 * 24 * 60;

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
 * - setup: the account has no password yet; the user must choose one.
 * - change: the password is expired or temporary and must be replaced.
 */
export type LoginResult =
  | { status: 'ok'; user: AuthUser }
  | { status: 'setup' }
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
