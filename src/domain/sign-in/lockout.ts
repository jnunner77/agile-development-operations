/** Failed sign-ins in a row before a username is locked. */
export const MAX_FAILURES = 5;
export const LOCK_MS = 5 * 60_000;
/** A username's failed attempts are forgotten after this long without another one. */
export const FAILURE_WINDOW_MS = 15 * 60_000;

/** Recent failed sign-ins for one username. Times are milliseconds since the epoch. */
export interface FailedAttempts {
  readonly count: number;
  readonly lockedUntil: number;
  readonly last: number;
}

/** Failures are counted per username, ignoring case and surrounding spaces. */
export const lockoutKey = (username: string): string => username.trim().toLowerCase();

/** Whole minutes until the username unlocks, or 0 if it isn't locked. */
export function minutesLocked(record: FailedAttempts | undefined, now: Date): number {
  if (!record || record.lockedUntil <= now.getTime()) return 0;
  return Math.ceil((record.lockedUntil - now.getTime()) / 60_000);
}

/** The record after one more failure: old failures are forgotten, and too many lock the username. */
export function afterFailure(record: FailedAttempts | undefined, now: Date): FailedAttempts {
  const at = now.getTime();
  const stale = !record || (record.lockedUntil !== 0 && record.lockedUntil <= at) || at - record.last > FAILURE_WINDOW_MS;
  const count = (stale ? 0 : record.count) + 1;
  if (count >= MAX_FAILURES) return { count: 0, lockedUntil: at + LOCK_MS, last: at };
  return { count, lockedUntil: stale ? 0 : record.lockedUntil, last: at };
}

/** Records that no longer lock anything and are past the window can be dropped. */
export function isForgotten(record: FailedAttempts, now: Date): boolean {
  return record.lockedUntil <= now.getTime() && now.getTime() - record.last > FAILURE_WINDOW_MS;
}
