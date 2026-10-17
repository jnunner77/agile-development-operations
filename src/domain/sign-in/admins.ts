import type { Member } from '../types.ts';
import type { Account } from './account.ts';

/** An administrator who can actually sign in: active, with a username and a password. */
export function hasUsableAdmin(members: readonly Member[], accountOf: (memberId: string) => Account | undefined): boolean {
  return members.some((m) => {
    const account = accountOf(m.id);
    return m.active && !!m.username && !!account?.isAdmin && account.hasPassword;
  });
}

/** Look accounts up by member. */
export function accountsByMember(accounts: readonly Account[]): (memberId: string) => Account | undefined {
  const map = new Map(accounts.map((a) => [a.memberId, a]));
  return (memberId) => map.get(memberId);
}
