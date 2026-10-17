import type { Account } from '#domain/sign-in/account.ts';
import { accountsByMember } from '#domain/sign-in/admins.ts';
import type { MemberError } from '#domain/team/member.ts';
import type { Member } from '#domain/types.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { SignInDeps } from './deps.ts';

export async function findTeamMember(deps: Pick<SignInDeps, 'team'>, memberId: string): Promise<Result<Member, MemberError>> {
  const member = await deps.team.findById(memberId);
  return member ? ok(member) : err({ code: 'MEMBER_NOT_FOUND', id: memberId });
}

/** Everyone's accounts, with one replaced by a changed version not saved yet. */
export async function accountsWith(deps: Pick<SignInDeps, 'accounts'>, changed: Account): Promise<(memberId: string) => Account | undefined> {
  const saved = accountsByMember(await deps.accounts.all());
  return (memberId) => (memberId === changed.memberId ? changed : saved(memberId));
}
