import { err, ok, type Result } from '#shared/result.ts';
import type { Member } from '../types.ts';

export const MAX_USERNAME_LENGTH = 64;

export type UsernameError = { readonly code: 'USERNAME_REQUIRED' } | { readonly code: 'TEXT_TOO_LONG'; readonly field: 'username'; readonly max: number };

/** A username someone typed to sign in: trimmed, not empty, not absurdly long. */
export function checkTypedUsername(raw: string): Result<string, UsernameError> {
  const username = raw.trim();
  if (!username) return err({ code: 'USERNAME_REQUIRED' });
  if (username.length > MAX_USERNAME_LENGTH) return err({ code: 'TEXT_TOO_LONG', field: 'username', max: MAX_USERNAME_LENGTH });
  return ok(username);
}

/** Only active members with a username can sign in. Usernames match ignoring case. */
export function memberForUsername(members: readonly Member[], username: string): Member | undefined {
  const wanted = username.trim().toLowerCase();
  return members.find((m) => m.active && !!m.username && m.username.toLowerCase() === wanted);
}
