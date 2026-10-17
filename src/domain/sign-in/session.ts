/** Sessions end after this long however active they are (or the inactivity timeout, if longer). */
export const SESSION_MAX_AGE_MS = 24 * 60 * 60_000;
/** The oldest sessions are dropped beyond this many per person. */
export const MAX_SESSIONS_PER_MEMBER = 20;

/** A signed-in browser. The token is the secret in its cookie. Times are milliseconds since the epoch. */
export interface Session {
  readonly token: string;
  readonly memberId: string;
  readonly createdAt: number;
  readonly lastSeen: number;
}

export const sessionMaxAgeMs = (timeoutMinutes: number): number => Math.max(SESSION_MAX_AGE_MS, timeoutMinutes * 60_000);

/** Whether a session is still within its inactivity timeout and maximum age. */
export function isSessionLive(session: Session, now: Date, timeoutMinutes: number): boolean {
  const at = now.getTime();
  return at - session.lastSeen <= timeoutMinutes * 60_000 && at - session.createdAt <= sessionMaxAgeMs(timeoutMinutes);
}

/** The member's oldest sessions to end so a new one keeps them within the limit. */
export function sessionsToEnd(memberSessions: readonly Session[]): Session[] {
  const oldestFirst = [...memberSessions].sort((a, b) => a.createdAt - b.createdAt);
  return oldestFirst.slice(0, Math.max(0, oldestFirst.length - MAX_SESSIONS_PER_MEMBER + 1));
}
