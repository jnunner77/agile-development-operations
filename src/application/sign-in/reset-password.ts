import { hasUsableAdmin } from '#domain/sign-in/admins.ts';
import { lockoutKey } from '#domain/sign-in/lockout.ts';
import { err, ok, type Result } from '#shared/result.ts';
import { requireAdmin } from '../access.ts';
import type { Caller } from '../caller.ts';
import type { AuthAdminView } from '../contracts/auth.ts';
import { publish, signInState, type SignInDeps, type SignInError } from './deps.ts';
import { adminView, endSessions, revokeTokens } from './helpers.ts';
import { accountsWith, findTeamMember } from './team.ts';

/** Clear someone's password: they can't sign in until an administrator sets a new one. */
export class ResetPassword {
  readonly #deps: SignInDeps;

  constructor(deps: SignInDeps) {
    this.#deps = deps;
  }

  async execute(input: { readonly caller: Caller; readonly memberId: string }): Promise<Result<AuthAdminView, SignInError>> {
    const access = requireAdmin(input.caller);
    if (!access.ok) return access;
    const deps = this.#deps;
    const member = await findTeamMember(deps, input.memberId);
    if (!member.ok) return member;
    const account = await deps.accounts.get(input.memberId);
    account.clearPassword(deps.clock.now());
    const { enabled } = await signInState(deps);
    if (enabled && !hasUsableAdmin(await deps.team.all(), await accountsWith(deps, account))) return err({ code: 'ACCOUNT_IS_LAST_ADMIN' });
    await deps.accounts.save(account);
    if (member.value.username) await deps.failedAttempts.delete(lockoutKey(member.value.username));
    await endSessions(deps, input.memberId);
    await revokeTokens(deps, input.memberId);
    await publish(deps, account);
    return ok(await adminView(deps));
  }
}
